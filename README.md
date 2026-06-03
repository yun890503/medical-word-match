# 醫學英文字根字尾配對競賽系統

醫學英文單字字根（Root）與字尾（Suffix）配對競賽系統，使用 Vite + React + TypeScript 製作前台，Node.js + Express + Socket.IO 提供 API 與即時同步。

## 資料儲存

系統使用 MySQL 儲存可變更資料：

- 隊伍帳號
- 教師帳號
- 比賽設定
- 比賽狀態
- 分數與作答紀錄

題目資料目前不寫入 MySQL，而是由伺服器啟動時載入記憶體題庫，前台作答時直接使用快取資料，避免每題都查詢資料庫。教師在後台匯入或修改題目後，題目會在目前伺服器執行期間生效；若服務重新啟動，題目會回到程式內建預設題庫。

如果之後想讓題目也能永久保存，同時維持速度，可以改成「題目存 MySQL，但伺服器啟動時一次載入記憶體快取」。

## 本機開發

```bash
npm install
npm run dev
```

前台網址：

```text
http://localhost:5173
```

後端 API：

```text
http://localhost:3001
```

本機啟動後端前，需要設定 MySQL 環境變數：

```text
MYSQL_HOST=你的 MySQL 主機
MYSQL_PORT=你的 MySQL 連接埠
MYSQL_USER=你的 MySQL 帳號
MYSQL_PASSWORD=你的 MySQL 密碼
MYSQL_DATABASE=你的 MySQL 資料庫
```

也可以使用 `DATABASE_URL` 或 `MYSQL_URL`。

## 預設登入帳號

教師帳號：

| 帳號 | 密碼 |
| --- | --- |
| admin | admin123 |

隊伍登入：

學生在登入頁輸入教師後台已建立的隊伍名稱與密碼即可進入。預設隊伍為 Team1 至 Team7，密碼為 team1 至 team7。教師可在後台新增、刪除、修改隊伍名稱、密碼與啟用狀態。

## 權限規則

- 未登入只能看到登入頁。
- 教師登入後可進入教師後台與大螢幕。
- 隊伍必須由教師後台建立或啟用，學生使用隊伍名稱與密碼登入。
- 隊伍登入後只能進入競賽頁與大螢幕。
- 隊伍帳號不會看到教師後台入口，也無法透過狀態切換進入教師後台。
- 教師後台可新增、修改、停用與刪除教師帳號。
- 系統會避免刪除或停用最後一個啟用中的教師帳號，避免後台被鎖死。

## 隊伍登入鎖

為了避免多位學生同時使用同一個隊伍帳號造成分數或題目進度混亂，系統使用課堂競賽版登入鎖：

- 比賽未開始或已結束時，同一隊伍可以重新登入；新的裝置會取代舊裝置。
- 比賽進行中或暫停中，同一隊伍只允許原本那一台裝置繼續使用。
- 如果比賽中用另一台裝置登入同一隊伍，系統會拒絕登入並提示請老師解除登入鎖。
- 舊裝置被新裝置取代時，會自動回到登入頁並顯示提示。
- 教師可在後台「隊伍管理」看到隊伍是否已登入鎖定，並可按「解除登入鎖」讓該隊重新登入。

建議課堂流程：

1. 教師先建立或確認 Team1 至 Team7 的名稱與密碼。
2. 比賽開始前，讓各隊用自己的隊伍帳號登入。
3. 若比賽開始前有學生換裝置，直接重新登入即可。
4. 比賽開始後，若某隊真的需要換裝置，教師到「隊伍管理」按該隊的「解除登入鎖」。
5. 學生再用同一隊伍名稱與密碼在新裝置登入。

## 主要功能

- 字根與字尾拖曳配對
- 字根與字尾點選配對
- 答對 1 分，答錯 0 分
- 教師後台可新增、刪除與管理隊伍
- 倒數計時
- 即時排行榜
- 大螢幕投影模式
- 題庫 Excel 匯入
- 教師、隊伍、比賽設定管理
- 作答紀錄匯出 Excel
- 成績報表匯出 PDF

## Excel 匯入格式

支援下列欄位名稱：

| 中文 | 完整單字 | 字根 | 字尾 |
| --- | --- | --- | --- |
| 神經學 | Neurology | neur | ology |
| 心臟學 | Cardiology | cardi | ology |

也可使用 `中文名稱` 取代 `中文`。

## Zeabur 部署

專案已提供 `zbpack.json`，Zeabur 會使用：

```text
build_command: npm install && npm run build
start_command: npm start
```

部署步驟：

1. 將專案 push 到 GitHub。
2. 在 Zeabur 建立 Project。
3. 新增 GitHub Repository 服務並選擇此專案。
4. 在 Zeabur 的 Web 服務加入 MySQL 環境變數。
5. 重新部署 Web 服務。

Zeabur Web 服務需要設定：

```text
MYSQL_HOST=你的 MySQL host
MYSQL_PORT=你的 MySQL port
MYSQL_USER=你的 MySQL username
MYSQL_PASSWORD=你的 MySQL password
MYSQL_DATABASE=你的 MySQL database
```

請不要把 MySQL 密碼寫進 GitHub 程式碼或 README，密碼只放在 Zeabur 的 Environment Variables。
