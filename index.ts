import { postEvent, _postData } from "./interface/postEvent";
import { jsonMessage } from "./interface/chatworkMessage";
import { contexts, embeddingResponse, gptResponse } from "./interface/chatGPT";

const GPT_TOKEN = PropertiesService.getScriptProperties().getProperty('GPTKEY'); //ChatGPTのAPIキーを入れてください
const CHATWORK_TOKEN = PropertiesService.getScriptProperties().getProperty('CHATWORKKEY');    // CHATWORKのAPIキーを入れてください
const SPREADSHEET = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEETKEY') as string);

const GPT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const EMBEDDING_ENDPOINT = 'https://api.openai.com/v1/embeddings';
const EMMODEL_NAME = 'text-embedding-ada-002';
const MODEL_NAME = 'gpt-3.5-turbo';
const MODEL_TEMP = 0.5;
const MAX_TOKENS = 512;

// CHATWORKからPOSTリクエストが渡されてきたときに実行される処理
async function doPost(e: postEvent) {
    try {
        // CHATWORKからPOSTされるJSON形式のデータをGASで扱える形式(JSオブジェクト)に変換
        const json = JSON.parse(e.postData.contents) as jsonMessage;
        // CHATWORK側へ応答するためのroomidを作成
        const reply_token = json.webhook_event.room_id;
        if (typeof reply_token === 'undefined') {
            return;
        }

        // LINEから送られてきたメッセージを取得
        const user_message = json.webhook_event.body;
        setLog(`${json.webhook_event.from_account_id}：メッセージが送信されました。`);

        // userIDごとにチャット履歴があるか確認する。
        let messages = await chat(`${json.webhook_event.from_account_id}:user`, user_message);

        if (user_message !== "[削除]") {
            if (!messages) {
                messages = [{
                    role: "user", content: `${user_message}`
                }]
            }

            const headers = {
                'Authorization': 'Bearer ' + GPT_TOKEN,
                'Content-type': 'application/json',
                'X-Slack-No-Retry': '1'
            };
            // リクエストオプション
            const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
                'method': 'post',
                'muteHttpExceptions': true,
                'headers': headers,
                'payload': JSON.stringify({
                    'model': MODEL_NAME,        // 使用するGPTモデル
                    'max_tokens': MAX_TOKENS,   // レスポンストークンの最大値(最大4,096)
                    'temperature': MODEL_TEMP,  // 応答の多様性(0-1)※数値が大きいほどランダムな応答になる
                    'messages': messages
                })
            };
            // HTTPリクエストでChatGPTのAPIを呼び出す
            const res = JSON.parse(UrlFetchApp.fetch(GPT_ENDPOINT, options).getContentText()) as gptResponse;
            // ChatGPTから返却されたメッセージを応答メッセージとしてLINEに返す
            chatworkReply(json, res.choices[0].message.content.trimStart());

            if (!user_message.includes("[制約]")) {
                chat(`${json.webhook_event.from_account_id}:assistant`, res.choices[0].message.content.trimStart());
            }
        } else {
            chatworkReply(json, "チャット履歴が削除されました。");
        }

    } catch (err) {
        setLog(err);
    }
}

// LINEへの応答
function chatworkReply(json: jsonMessage, replyText: string) {

    // ChatworkAPIクライアント作成
    const client = ChatWorkClient.factory({ token: CHATWORK_TOKEN });

    //ChatworkAPIクライアントからメッセージ投稿
    client.sendMessage({
        room_id: json.webhook_event.room_id,
        body: "[info][title]チャットGPTからの返信[/title]" + replyText + "[/info]"
    });
}

function chat(userID: string, newChat: string): Promise<void | { role: string; content: string }[]> {
    return new Promise(async (resolve, reject) => {
        const chatVal = [];
        const rowIndices = [];
        const exists = checkSheetExists(userID.split(":")[0]);
        let chatSheet: GoogleAppsScript.Spreadsheet.Sheet;
        if (exists) {
            chatSheet = SPREADSHEET.getSheetByName(userID.split(":")[0]) as GoogleAppsScript.Spreadsheet.Sheet;
        } else {
            await createNewSheetAtTop(userID.split(":")[0])
            chatSheet = SPREADSHEET.getSheetByName(userID.split(":")[0]) as GoogleAppsScript.Spreadsheet.Sheet;
        }
        let chatLastRow = chatSheet.getLastRow();
        let userIDArr = chatSheet.getRange(2, 1, chatLastRow, 1).getValues(); // チャット履歴からすべてのuserIDを取得

        // 今回のメッセージの内容を追加
        if (newChat !== "[削除]" && !newChat.includes("[制約]")) {
            let now = new Date();
            let jpTime = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
            chatSheet.getRange(chatLastRow + 1, 1).setValue(userID); // userID
            chatSheet.getRange(chatLastRow + 1, 2).setValue(jpTime); // chat出力時間
            chatSheet.getRange(chatLastRow + 1, 3).setValue(newChat); // chatの出力
        }

        // 通常のチャットのやり取り
        if (!newChat.includes("[制約]")) {
            for (let i = 0; i < userIDArr.length; i++) {
                if (userIDArr[i].toString().split(":")[0] == userID.split(":")[0]) {
                    rowIndices.push({
                        "index": i + 2,
                        "role": userIDArr[i].toString().split(":")[1],
                    });
                }

                if (i == userIDArr.length - 1) {
                    if (rowIndices.length > 0) {
                        if (newChat == "[削除]") {
                            for (let ii = 0; ii < rowIndices.length; ii++) {
                                // 該当のuserIDのチャットをクリア
                                chatSheet.getRange(rowIndices[ii].index, 1).clearContent();
                                chatSheet.getRange(rowIndices[ii].index, 2).clearContent();
                                chatSheet.getRange(rowIndices[ii].index, 3).clearContent();
                                if (ii == rowIndices.length - 1) {
                                    resolve();
                                }
                            }
                        } else {
                            for (let ii = 0; ii < rowIndices.length; ii++) {
                                chatVal.push({ 'role': rowIndices[ii].role, 'content': `"${chatSheet.getRange(rowIndices[ii].index, 3, 1, 1).getValue()}"` });
                                if (ii == rowIndices.length - 1) {
                                    resolve(chatVal);
                                }
                            }
                        }
                    } else {
                        resolve();
                    }
                }
            }
        } else {
            const embeddingSheet = SPREADSHEET.getSheetByName("embedding") as GoogleAppsScript.Spreadsheet.Sheet;
            const embeddingLastRow = embeddingSheet.getLastRow();
            const embeddingLastColumn = embeddingSheet.getLastColumn();
            let knowLedges = [];
            for (let i = 2; i <= embeddingLastRow; i++) {
                knowLedges.push({
                    text: embeddingSheet.getRange(i, 2).getValue() as string,
                    vector: embeddingSheet.getRange(i, 3, 1, embeddingLastColumn).getValues()[0] as number[]
                });
                if (i == embeddingLastRow) {
                    let message = await createMessage(knowLedges, newChat);
                    resolve(message);
                }
            };
        }
    });
}

// シートの検索
function checkSheetExists(sheetName: string) {
    let sheets = SPREADSHEET.getSheets();

    for (let i = 0; i < sheets.length; i++) {
        if (sheets[i].getName() == sheetName) {
            return true;
        }
    }

    return false;
}

// シートの作成
function createNewSheetAtTop(sheetName: string): Promise<void> {
    return new Promise((resolve, reject) => {
        let newSheet = SPREADSHEET.insertSheet(0);
        newSheet.setName(sheetName);
        newSheet.getRange(1, 1, 1, 3).setValues([["userID", "日時", "内容"]]);
        resolve();
    })
}

// ログの出力
function setLog(val: string | unknown) {
    const logSheet = SPREADSHEET.getSheetByName('log') as GoogleAppsScript.Spreadsheet.Sheet;
    const logLastRow = logSheet.getLastRow();
    let now = new Date();
    let jpTime = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
    logSheet.getRange(logLastRow + 1, 1).setValue(jpTime); // ログ時間出力
    logSheet.getRange(logLastRow + 1, 2).setValue(val); // ログの出力
}

async function createEmbedding(input: string) {
    try {
        const headers = {
            'Authorization': 'Bearer ' + GPT_TOKEN,
            'Content-type': 'application/json',
        };
        // リクエストオプション
        const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
            'method': 'post',
            'muteHttpExceptions': true,
            'headers': headers,
            'payload': JSON.stringify({
                'model': EMMODEL_NAME,
                'input': input
            })
        };
        // HTTPリクエストでChatGPTのAPIを呼び出す
        const res = JSON.parse(UrlFetchApp.fetch(EMBEDDING_ENDPOINT, options).getContentText()) as embeddingResponse;
        return res.data[0].embedding;
    } catch (e) {
        console.log(e)
        throw e
    }
}

async function getRelevantContexts(contexts: contexts[], message: string) {
    // 前提知識の配列ベクトルと質問文ベクトルの内積を計算
    function dot(a: number[], b: number[]): number {
        return a.map((x, i) => {
            return a[i] * b[i];
        }).reduce((m, n) => {
            return m + n;
        })
    }

    const messageVec = await createEmbedding(message);

    return contexts.map((context) => {
        return {
            ...context,
            similarity: dot(messageVec, context.vector)
        }
    }).sort((a, b) => {
        return b.similarity - a.similarity
    }).slice(0, 3).map((i) => {
        return i.text
    })
}

function createMessage(knowLedges: contexts[], input: string): Promise<{ role: string; content: string }[]> {
    return new Promise(async (resolve, reject) => {
        try {
            const relevanceList = await getRelevantContexts(knowLedges, input);
            const prompt =
                `以下の制約条件に従って、株式会社エンラプトのお問い合わせ窓口チャットボットとしてロールプレイをします。
  ---
  # 制約条件:
  - 制約情報を基に質問文に対する回答文を生成してください。
  - 回答は見出し、箇条書き、表などを使って人間が読みやすく表現してください。
  
  ---
  # 制約情報:
  ${relevanceList.join('\n\n')}
  
  ---
  # 質問文:
  ${input}
  
  ---
  # 回答文:
  `
            resolve([{ role: "user", content: prompt }]);
        } catch (error) {
            setLog(error);
        }
    });
}