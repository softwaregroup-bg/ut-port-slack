const {PassThrough} = require('readable-stream');
const request = (process.type === 'renderer') ? require('ut-browser-request') : require('request');
const mailToRegEx = /<mailto:([^>]+?)\|[^>]*?>/g;
const sanitize = text => (typeof text === 'string') ? text.replace(mailToRegEx, '$1') : text; // replace all <a href="mailto:...">...</a>
const parse = text => {
    try {
        return JSON.parse(text);
    } catch (e) {
        return text;
    }
};
const image = attachments => attachments
    .filter(image => typeof image === 'string' || /^image\/(jpeg|png|gif)$/.test(image.contentType))
    .map(image => typeof image === 'string' ? {
        type: 'image',
        image_url: image,
        alt_text: image
    } : {
        type: 'image',
        image_url: image.url,
        alt_text: image.title
    });
const button = attachments => attachments
    .filter(button => typeof button === 'string' || button.contentType === 'application/x.button')
    .map((button, index) => typeof button === 'string' ? {
        type: 'button',
        text: {
            type: 'plain_text',
            text: button
        },
        action_id: 'imBack-' + index,
        value: JSON.stringify({text: button})
    } : {
        type: 'button',
        text: {
            type: 'plain_text',
            text: button.title || button.value
        },
        action_id: button.action || ('imBack-' + index),
        value: JSON.stringify(typeof button.value === 'string' ? {text: button.value} : button.value)
    });
const location = attachments => [].concat(...attachments
    .filter(location => location.contentType === 'application/x.location' && location.details)
    .map(location => [{
        type: 'image',
        image_url: location.thumbnail,
        alt_text: location.details.address
    }, {
        type: 'section',
        text: {
            type: 'mrkdwn',
            text: `*${location.title}*\n<${location.url}|${location.details.address}>`
        }
    }]));

const body = msg => {
    const channel = msg.receiver.conversationId;
    switch (msg && msg.type) {
        case 'text': return {
            channel,
            mrkdwn: true,
            text: (msg.details && msg.details.timePrefix) ? `<!date^${Math.floor(msg.timestamp.getTime() / 1000)}^{date_short_pretty} {time}|${msg.timestamp.toLocaleString()}>\n${msg.text}` : msg.text
        };
        case 'location': return {
            channel,
            text: msg.text,
            blocks: location(msg.attachments).concat([{
                type: 'section',
                text: {
                    type: 'plain_text',
                    text: msg.text
                }
            }])
        };
        case 'image': return {
            channel,
            text: msg.text,
            blocks: image(msg.attachments).concat([{
                type: 'section',
                text: {
                    type: 'plain_text',
                    text: msg.text
                }
            }])
        };
        case 'quick': return {
            channel,
            text: msg.text,
            blocks: [{
                type: 'section',
                text: {
                    type: 'plain_text',
                    text: msg.text
                }
            }, {
                type: 'actions',
                elements: button(msg.attachments)
            }]
        };
        default: return false;
    }
};

module.exports = function slack({utMethod}) {
    const getToken = (auth, type) => JSON.parse(auth.accessToken)[type];

    return class slack extends require('ut-port-webhook')(...arguments) {
        get defaults() {
            return {
                path: '/slack/{appId}/{clientId}/{action?}',
                hook: 'slackIn',
                namespace: 'slack',
                // mode: 'reply',
                server: {
                    port: 8085
                },
                request: {
                    baseUrl: 'https://slack.com/api/'
                },
                response: {
                    body: {}
                }
            };
        }

        handlers() {
            const {namespace, hook} = this.config;
            return {
                start: async() => {
                    this.httpServer.route({
                        method: 'GET',
                        path: '/slack/{appId}/{clientId}/attachment',
                        options: {
                            auth: false,
                            handler: async({query, params}, h) => {
                                const {url} = query;
                                if (!url) return h.response().code(404);
                                const auth = await utMethod('bot.botContext.fetch#[0]')({
                                    platform: 'slack',
                                    appId: params.appId,
                                    clientId: params.clientId
                                });
                                return h.response(request({
                                    url,
                                    headers: {
                                        Authorization: 'Bearer ' + await getToken(auth, 'bot')
                                    }
                                }).pipe(new PassThrough()));
                            }
                        }
                    });
                },
                [`${hook}.identity.request.receive`]: (msg, {params, headers}) => {
                    return {
                        clientId: params.clientId,
                        appId: params.appId,
                        platform: 'slack'
                    };
                },
                [`${hook}.identity.response.send`]: async(msg, {headers, payload}) => {
                    return msg;
                },
                [`${hook}.message.request.receive`]: (msg, $meta) => {
                    let message = false;
                    if ($meta.params && $meta.params.action) {
                        msg = JSON.parse(msg.payload);
                    }

                    $meta.opcode = msg.type;
                    switch (msg.type) {
                        case 'block_actions': {
                            const found = msg.actions.find(action => action && action.action_id);
                            if (found) {
                                message = {
                                    type: 'action',
                                    messageId: msg.trigger_id,
                                    timestamp: parseInt(found.action_ts.split('.')[0], 10),
                                    sender: {
                                        id: msg.user.id,
                                        platform: 'slack',
                                        contextId: $meta.auth.contextId,
                                        conversationId: msg.channel.id
                                    },
                                    receiver: {
                                        id: msg.channel.id
                                    },
                                    text: found.action_id.split('-', 2)[0],
                                    details: {...parse(found.value), users: [msg.user.id], bot: msg.message.bot_id},
                                    request: msg
                                };
                            }
                            break;
                        }
                        case 'url_verification':
                            $meta.dispatch = (_, $meta) => [_, {...$meta, mtid: 'response'}];
                            break;
                        case 'event_callback':
                            if (msg.event.type === 'message') {
                                if (msg.event.subtype === 'bot_message' || msg.event.bot_id) return false;
                                message = {
                                    type: 'text',
                                    messageId: msg.event.client_msg_id,
                                    timestamp: parseInt(msg.event.ts.split('.')[0], 10),
                                    sender: {
                                        id: msg.event.user,
                                        platform: 'slack',
                                        contextId: $meta.auth.contextId,
                                        conversationId: msg.event.channel
                                    },
                                    receiver: {
                                        id: msg.event.channel
                                    },
                                    text: sanitize(msg.event.text),
                                    request: msg
                                };
                                if (msg.event.subtype === 'file_share') {
                                    message.attachments = (msg.event.files || []).map(({url_private_download: url, mimetype, name}) => {
                                        const download = new URL(`${$meta.url.pathname}/attachment`, this.getUriFromMeta($meta));
                                        download.searchParams.set('url', url);
                                        return {
                                            url: download.href,
                                            contentType: mimetype,
                                            filename: name
                                        };
                                    });
                                }
                            }
                            break;
                    }
                    return message;
                },
                [`${hook}.server.response.send`]: async(msg) => {
                    if (msg && msg.type === 'url_verification') return {body: {challenge: msg.challenge}};
                },
                [`${hook}.message.response.send`]: async(msg, {auth}) => {
                    return msg && {
                        url: 'chat.postMessage',
                        headers: {
                            Authorization: 'Bearer ' + await getToken(auth, 'bot')
                        },
                        body: {
                            ...body(msg),
                            as_user: true
                        }
                    };
                },
                [`${namespace}.message.send.response.receive`]: msg => {
                    this.log.debug(msg);
                    return false;
                },
                [`${namespace}.message.send.request.send`]: async(msg, {auth}) => {
                    const isBot = ['dialogflow'].includes(msg.sender.platform);
                    return msg && {
                        url: 'chat.postMessage',
                        headers: {
                            Authorization: 'Bearer ' + await getToken(auth, 'app')
                        },
                        body: {
                            ...body(msg),
                            username: isBot ? 'bot' : (msg.sender.platform + ' user'),
                            icon_emoji: isBot ? ':computer:' : ':adult:'
                        }
                    };
                },
                [`${namespace}.conversation.create.request.send`]: async(msg, {auth}) => {
                    return {
                        url: 'conversations.create',
                        body: {
                            name: msg.name,
                            user_ids: msg.users.join(',')
                        },
                        headers: {
                            Authorization: 'Bearer ' + await getToken(auth, 'app')
                        }
                    };
                },
                [`${namespace}.conversation.create.response.receive`]: async(msg) => {
                    return msg.channel;
                }
            };
        }
    };
};
