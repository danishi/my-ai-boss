import { App, AwsLambdaReceiver } from '@slack/bolt';
import {
    AwsCallback,
    AwsEvent
} from '@slack/bolt/dist/receivers/AwsLambdaReceiver';
import { isAxiosError } from 'axios';
import {
    ChatCompletionRequestMessage,
    Configuration,
    OpenAIApi
} from 'openai';

if (!process.env.SLACK_SIGNING_SECRET) process.exit(1);

const configuration = new Configuration({
    apiKey: process.env.OPENAI_API_KEY
});
const openai = new OpenAIApi(configuration);

const awsLambdaReceiver = new AwsLambdaReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET
});
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    receiver: awsLambdaReceiver
});

const botMemberId = process.env.BOT_USER_ID;

// メンションされたら返信する
app.event('app_mention', async ({ event, context, client, say }) => {
    // リトライ時は何もしない
    if (context.retryNum) {
        console.log(
            `skipped retry. retryReason: ${context.retryReason}`
        );
        return;
    }
    console.log(event);

    try {
        const { channel, thread_ts, event_ts } = event;
        const threadTs = thread_ts ?? event_ts;
        // 処理中メッセージを返す（必要ならコメントイン）
        // await say({
        //     channel,
        //     thread_ts: threadTs,
        //     text: '考え中:thinking:'
        // });

        try {
            // スレッドのメッセージを取得
            const threadResponse = await client.conversations.replies({
                channel,
                ts: threadTs
            });
            // メッセージを整形
            const chatCompletionRequestMessage: ChatCompletionRequestMessage[] =
                [];
            let isUserFirst = true;
            threadResponse.messages?.forEach((message) => {
                console.log(message);
                const { text, user } = message;
                if (!text) return;

                if (user && user === botMemberId) {
                    // 考え中以外の発言をアシスタントの発言として取り込む
                    if (!text.startsWith('考え中')) {
                        chatCompletionRequestMessage.push({
                            role: 'assistant',
                            content: text
                        });
                    }
                } else {
                    // ユーザーの発言を取り込む
                    let prompt = text.replace(`<@${botMemberId}>`, '') ?? ''
                    // 初回のユーザー発言のみ、プロンプトを追加
                    if(isUserFirst){
                        const rolePrompt = `
                        以下のロールプレイをしてください。
                        ・あなたは理想的な上司です。
                        ・一人称は「ワイ」で話してください。
                        ・敬語は使わず、タメ口で話してください。
                        ・絵文字を多用してください。
                        ・筋トレの話をしてください。
                        ・最後は飲みに行こうぜで締めてください。
                        ------------------------------
                        `;
                        prompt = rolePrompt + prompt
                        isUserFirst = false;
                    }
                    
                    console.log('prompt: ' + prompt);
                    chatCompletionRequestMessage.push({
                        role: 'user',
                        content:
                            prompt
                    });
                }
            });

            // OpenAIに投げる
            const completion = await openai.createChatCompletion({
                model: 'gpt-3.5-turbo',
                messages: chatCompletionRequestMessage
            });

            // 結果を返信
            const outputText = completion.data.choices
                .map(({ message }) => message?.content)
                .join('');
            console.log(outputText);

            await client.chat.postMessage({
                channel,
                thread_ts: threadTs,
                text: outputText
            });

        } catch (error) {
            // エラーが発生した
            if (isAxiosError(error)) {
                console.error(error.response?.data);
            } else {
                console.error(error);
            }
            await client.chat.postMessage({
                channel,
                thread_ts: threadTs,
                text: 'うまくいきませんでした:cry:'
            });
        }
    } catch (error) {
        console.error(error);
    }
});

// メッセージが来たら返信する
module.exports.handler = async (
    event: AwsEvent,
    context: unknown,
    callback: AwsCallback
) => {
    const handler = await awsLambdaReceiver.start();
    return handler(event, context, callback);
};
