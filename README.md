# 醫學英文字根字尾配對競賽系統

醫學英文單字字根（Root）與字尾（Suffix）配對競賽系統。此版本使用 Vite + React + TypeScript 前端，搭配 Node/Express/Socket.IO 本機後端。

題庫、隊伍、教師帳號、比賽狀態、分數與作答紀錄會儲存在 SQLite 資料庫。預設資料庫路徑是 `server/data/medical-match.sqlite`，也可用 `DB_PATH` 環境變數指定。多個瀏覽器或多台電腦連到同一台主機時，排行榜與作答資料會即時同步。

## 啟動方式

```bash
npm install
npm run dev
```

前端網址：

```text
http://localhost:5173
```

後端 API：

```text
http://localhost:3001
```

## 預設帳號

教師後台：

| 帳號 | 密碼 |
| --- | --- |
| admin | admin123 |

隊伍帳號：

| 帳號 | 密碼 |
| --- | --- |
| Team1 | team1 |
| Team2 | team2 |
| Team3 | team3 |
| Team4 | team4 |
| Team5 | team5 |
| Team6 | team6 |
| Team7 | team7 |

## 權限規則

- 未登入只能看到登入頁。
- 教師登入後可使用教師後台與大螢幕模式。
- 隊伍登入後只能使用競賽頁與大螢幕模式，不能看到或進入教師後台。
- 教師後台可新增、修改、停用與刪除教師帳號。
- 系統會阻止刪除或停用最後一個啟用中的教師帳號，避免後台無法登入。

## 已包含功能

- 同一登入頁支援教師與隊伍登入。
- 字根紅色、字尾黑色、答對組合結果綠色。
- 點選配對與拖曳配對。
- 自動組合完整單字並比對題庫答案。
- 答對 1 分，答錯 0 分。
- 7 隊隊伍管理、密碼修改、重設密碼、啟用/停用。
- 教師帳號新增、修改、停用、刪除。
- 後台題庫新增、修改、刪除。
- Excel 匯入題庫。
- 題數設定：10、20、30、50 題。
- 計時設定：3、5、10、15、20 分鐘與自訂分鐘。
- 開始、暫停、結束比賽控制。
- 排行榜依分數與完成時間排序。
- 即時公布或賽後公布排行榜。
- 後台查看各隊分數、排名與作答紀錄。
- 成績與作答紀錄匯出 Excel。
- 排名結果匯出 PDF。
- 大螢幕模式顯示倒數時間與排行榜。
- 後端 API 與 Socket.IO 即時同步狀態。
- SQLite 資料庫儲存題庫、隊伍、教師、比賽設定與作答紀錄。

## Excel 匯入格式

第一列請使用以下欄位名稱：

| 中文 | 完整單字 | 字根 | 字尾 |
| --- | --- | --- | --- |
| 神經學 | Neurology | neur | ology |
| 心臟學 | Cardiology | cardi | ology |

也支援把 `中文` 欄位寫成 `中文名稱`。

## 多台電腦使用方式

1. 在教師電腦執行 `npm run dev`。
2. 確認教師電腦與學生電腦在同一個網路。
3. 學生電腦用瀏覽器開啟教師電腦的區網 IP，例如：

```text
http://教師電腦IP:5173
```

正式長期部署時，建議改用正式資料庫、密碼雜湊與伺服器端登入權限驗證。

## Zeabur 部署

本專案已包含 `zbpack.json`，Zeabur 會使用：

```text
build_command: npm install && npm run build
start_command: npm start
```

部署流程：

1. 先將此專案推送到 GitHub。
2. 到 Zeabur 新增 Project。
3. 選擇 Deploy from GitHub Repository。
4. 選擇這個 repository。
5. Zeabur 會執行 build 並用 `npm start` 啟動服務。

正式部署後，前端、API 與 Socket.IO 都會由同一個 Zeabur 網址提供。

如果要讓 SQLite 資料在 Zeabur 重新部署後保留，請在 Zeabur 加上持久化 Volume，並設定環境變數：

```text
DB_PATH=/data/medical-match.sqlite
```
