const express = require('express');
const router = express.Router();
const { sendSuccess, sendError } = require('../utils/response');

// POST /feedback
router.post('/', async (req, res) => {
    try {
        const { message, type, employeeName, page } = req.body;

        if (!message) {
            return sendError(res, 'Feedback message is required.', 400);
        }

        const webhookUrl = process.env.SLACK_WEBHOOK_URL;
        if (!webhookUrl) {
            return sendError(
                res,
                'Slack integration is not configured. Please define SLACK_WEBHOOK_URL in your .env file.',
                501
            );
        }

        // Construct a clean, professional Slack message layout
        const slackPayload = {
            blocks: [
                {
                    type: "header",
                    text: {
                        type: "plain_text",
                        text: "📝 New App Feedback",
                        emoji: true
                    }
                },
                {
                    type: "section",
                    fields: [
                        {
                            type: "mrkdwn",
                            text: `*Submitted By:*\n${employeeName || 'Anonymous'}`
                        },
                        {
                            type: "mrkdwn",
                            text: `*Feedback Category:*\n${type || 'General'}`
                        }
                    ]
                }
            ]
        };

        if (page) {
            slackPayload.blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `*App View/Page:*\n\`${page}\``
                }
            });
        }

        slackPayload.blocks.push(
            {
                type: "divider"
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `*Message:*\n${message}`
                }
            }
        );

        // Send POST to Slack Webhook URL
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(slackPayload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Slack API responded with status ${response.status}: ${errorText}`);
        }

        return sendSuccess(res, { message: 'Feedback sent successfully' });
    } catch (err) {
        return sendError(res, err.message);
    }
});

module.exports = router;
