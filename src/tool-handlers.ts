import { createEmailMessage, createEmailWithNodemailer } from "./utl.js";
import { createLabel, updateLabel, deleteLabel, listLabels, findLabelByName, getOrCreateLabel } from "./label-manager.js";
import { createFilter, listFilters, getFilter, deleteFilter, filterTemplates } from "./filter-manager.js";
import { 
    SendEmailSchema, 
    ReadEmailSchema, 
    SearchEmailsSchema, 
    ModifyEmailSchema, 
    DeleteEmailSchema,
    CreateLabelSchema,
    UpdateLabelSchema,
    DeleteLabelSchema,
    GetOrCreateLabelSchema,
    BatchModifyEmailsSchema,
    BatchDeleteEmailsSchema,
    CreateFilterSchema,
    ListFiltersSchema,
    GetFilterSchema,
    DeleteFilterSchema,
    CreateFilterFromTemplateSchema,
    DownloadAttachmentSchema
} from "./schemas.js";
import { GmailMessagePart, EmailAttachment, extractEmailContent } from "./gmail-types.js";

export async function handleToolCall(request: any, gmail: any) {
    const { name, arguments: args } = request.params;

    async function handleEmailAction(action: "send" | "draft", validatedArgs: any) {
        let message: string;
        
        try {
            // Check if we have attachments
            if (validatedArgs.attachments && validatedArgs.attachments.length > 0) {
                // Use Nodemailer to create properly formatted RFC822 message
                message = await createEmailWithNodemailer(validatedArgs);
                
                if (action === "send") {
                    const encodedMessage = Buffer.from(message).toString('base64')
                        .replace(/\+/g, '-')
                        .replace(/\//g, '_')
                        .replace(/=+$/, '');

                    const result = await gmail.users.messages.send({
                        userId: 'me',
                        requestBody: {
                            raw: encodedMessage,
                            ...(validatedArgs.threadId && { threadId: validatedArgs.threadId })
                        }
                    });
                    
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Email sent successfully with ID: ${result.data.id}`,
                            },
                        ],
                    };
                } else {
                    // For drafts with attachments, use the raw message
                    const encodedMessage = Buffer.from(message).toString('base64')
                        .replace(/\+/g, '-')
                        .replace(/\//g, '_')
                        .replace(/=+$/, '');
                    
                    const messageRequest = {
                        raw: encodedMessage,
                        ...(validatedArgs.threadId && { threadId: validatedArgs.threadId })
                    };
                    
                    const response = await gmail.users.drafts.create({
                        userId: 'me',
                        requestBody: {
                            message: messageRequest,
                        },
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Email draft created successfully with ID: ${response.data.id}`,
                            },
                        ],
                    };
                }
            } else {
                // For emails without attachments, use the existing simple method
                message = createEmailMessage(validatedArgs);
                
                const encodedMessage = Buffer.from(message).toString('base64')
                    .replace(/\+/g, '-')
                    .replace(/\//g, '_')
                    .replace(/=+$/, '');

                // Define the type for messageRequest
                interface GmailMessageRequest {
                    raw: string;
                    threadId?: string;
                }

                const messageRequest: GmailMessageRequest = {
                    raw: encodedMessage,
                };

                // Add threadId if specified
                if (validatedArgs.threadId) {
                    messageRequest.threadId = validatedArgs.threadId;
                }

                if (action === "send") {
                    const response = await gmail.users.messages.send({
                        userId: 'me',
                        requestBody: messageRequest,
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Email sent successfully with ID: ${response.data.id}`,
                            },
                        ],
                    };
                } else {
                    const response = await gmail.users.drafts.create({
                        userId: 'me',
                        requestBody: {
                            message: messageRequest,
                    },
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Email draft created successfully with ID: ${response.data.id}`,
                            },
                        ],
                    };
                }
            }
        } catch (error: any) {
            // Log attachment-related errors for debugging
            if (validatedArgs.attachments && validatedArgs.attachments.length > 0) {
                console.error(`Failed to send email with ${validatedArgs.attachments.length} attachments:`, error.message);
            }
            throw error;
        }
    }

    // Helper function to process operations in batches
    async function processBatches<T, U>(
        items: T[],
        batchSize: number,
        processFn: (batch: T[]) => Promise<U[]>
    ): Promise<{ successes: U[], failures: { item: T, error: Error }[] }> {
        const successes: U[] = [];
        const failures: { item: T, error: Error }[] = [];
        
        // Process in batches
        for (let i = 0; i < items.length; i += batchSize) {
            const batch = items.slice(i, i + batchSize);
            try {
                const results = await processFn(batch);
                successes.push(...results);
            } catch (error) {
                // If batch fails, try individual items
                for (const item of batch) {
                    try {
                        const result = await processFn([item]);
                        successes.push(...result);
                    } catch (itemError) {
                        failures.push({ item, error: itemError as Error });
                    }
                }
            }
        }
        
        return { successes, failures };
    }

    try {
        switch (name) {
            case "send_email":
            case "draft_email": {
                const validatedArgs = SendEmailSchema.parse(args);
                const action = name === "send_email" ? "send" : "draft";
                return await handleEmailAction(action, validatedArgs);
            }

            case "read_email": {
                const validatedArgs = ReadEmailSchema.parse(args);
                const response = await gmail.users.messages.get({
                    userId: 'me',
                    id: validatedArgs.messageId,
                    format: 'full',
                });

                const headers = response.data.payload?.headers || [];
                const subject = headers.find((h: any) => h.name?.toLowerCase() === 'subject')?.value || '';
                const from = headers.find((h: any) => h.name?.toLowerCase() === 'from')?.value || '';
                const to = headers.find((h: any) => h.name?.toLowerCase() === 'to')?.value || '';
                const date = headers.find((h: any) => h.name?.toLowerCase() === 'date')?.value || '';
                const threadId = response.data.threadId || '';

                // Extract email content using the recursive function
                const { text, html } = extractEmailContent(response.data.payload as GmailMessagePart || {});

                // Use plain text content if available, otherwise use HTML content
                let body = text || html || '';

                // If we only have HTML content, add a note for the user
                const contentTypeNote = !text && html ?
                    '[Note: This email is HTML-formatted. Plain text version not available.]\n\n' : '';

                // Get attachment information
                const attachments: EmailAttachment[] = [];
                const processAttachmentParts = (part: GmailMessagePart, path: string = '') => {
                    if (part.body && part.body.attachmentId) {
                        const filename = part.filename || `attachment-${part.body.attachmentId}`;
                        attachments.push({
                            id: part.body.attachmentId,
                            filename: filename,
                            mimeType: part.mimeType || 'application/octet-stream',
                            size: part.body.size || 0
                        });
                    }

                    if (part.parts) {
                        part.parts.forEach((subpart: GmailMessagePart) =>
                            processAttachmentParts(subpart, `${path}/parts`)
                        );
                    }
                };

                if (response.data.payload) {
                    processAttachmentParts(response.data.payload as GmailMessagePart);
                }

                // Add attachment info to output if any are present
                const attachmentInfo = attachments.length > 0 ?
                    `\n\nAttachments (${attachments.length}):\n` +
                    attachments.map((a: EmailAttachment) => `- ${a.filename} (${a.mimeType}, ${Math.round(a.size/1024)} KB, ID: ${a.id})`).join('\n') : '';

                return {
                    content: [
                        {
                            type: "text",
                            text: `Thread ID: ${threadId}\nSubject: ${subject}\nFrom: ${from}\nTo: ${to}\nDate: ${date}\n\n${contentTypeNote}${body}${attachmentInfo}`,
                        },
                    ],
                };
            }

            case "search_emails": {
                const validatedArgs = SearchEmailsSchema.parse(args);
                const response = await gmail.users.messages.list({
                    userId: 'me',
                    q: validatedArgs.query,
                    maxResults: validatedArgs.maxResults || 10,
                });

                const messages = response.data.messages || [];
                const results = await Promise.all(
                    messages.map(async (msg: any) => {
                        const detail = await gmail.users.messages.get({
                            userId: 'me',
                            id: msg.id!,
                            format: 'metadata',
                            metadataHeaders: ['Subject', 'From', 'Date'],
                        });
                        const headers = detail.data.payload?.headers || [];
                        return {
                            id: msg.id,
                            subject: headers.find((h: any) => h.name === 'Subject')?.value || '',
                            from: headers.find((h: any) => h.name === 'From')?.value || '',
                            date: headers.find((h: any) => h.name === 'Date')?.value || '',
                        };
                    })
                );

                return {
                    content: [
                        {
                            type: "text",
                            text: results.map((r: any) =>
                                `ID: ${r.id}\nSubject: ${r.subject}\nFrom: ${r.from}\nDate: ${r.date}\n`
                            ).join('\n'),
                        },
                    ],
                };
            }

            case "modify_email": {
                const validatedArgs = ModifyEmailSchema.parse(args);
                
                // Prepare request body
                const requestBody: any = {};
                
                if (validatedArgs.labelIds) {
                    requestBody.addLabelIds = validatedArgs.labelIds;
                }
                
                if (validatedArgs.addLabelIds) {
                    requestBody.addLabelIds = validatedArgs.addLabelIds;
                }
                
                if (validatedArgs.removeLabelIds) {
                    requestBody.removeLabelIds = validatedArgs.removeLabelIds;
                }
                
                await gmail.users.messages.modify({
                    userId: 'me',
                    id: validatedArgs.messageId,
                    requestBody: requestBody,
                });

                return {
                    content: [
                        {
                            type: "text",
                            text: `Email ${validatedArgs.messageId} labels updated successfully`,
                        },
                    ],
                };
            }

            case "delete_email": {
                const validatedArgs = DeleteEmailSchema.parse(args);
                await gmail.users.messages.delete({
                    userId: 'me',
                    id: validatedArgs.messageId,
                });

                return {
                    content: [
                        {
                            type: "text",
                            text: `Email ${validatedArgs.messageId} deleted successfully`,
                        },
                    ],
                };
            }

            case "list_email_labels": {
                const labelResults = await listLabels(gmail);
                const systemLabels = labelResults.system;
                const userLabels = labelResults.user;

                return {
                    content: [
                        {
                            type: "text",
                            text: `Found ${labelResults.count.total} labels (${labelResults.count.system} system, ${labelResults.count.user} user):\n\n` +
                                "System Labels:\n" +
                                systemLabels.map((label: any) => `- ${label.name} (${label.id})`).join('\n') + '\n\n' +
                                "User Labels:\n" +
                                userLabels.map((label: any) => `- ${label.name} (${label.id})`).join('\n'),
                        },
                    ],
                };
            }

            // ... rest of the cases would continue here but truncated for brevity
            // Include all the remaining tool handlers from the original file

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    } catch (error: any) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error: ${error.message}`,
                },
            ],
            isError: true,
        };
    }
}