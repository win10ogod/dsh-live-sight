# dsh-live-sight

讓 DSH 的 Agent 跟你一起看螢幕：陪你玩遊戲、看影片、看你操作，也能在你要求時看清楚畫面再用 [dsh-kiseki-input](https://github.com/win10ogod/dsh-kiseki-input) 操作電腦。取代 [dsh-fount-reality](https://github.com/win10ogod/dsh-fount-reality)。

- **在同一段對話裡陪你**：畫面送進你正在聊的那段對話，Agent 帶著原本的記憶與個性看；不另開背景會話。
- **桌面懸浮窗**：永遠在最上層的對話卡片，玩遊戲時也看得到它說的話；可以直接在上面打字、暫停、收合成一行字幕、停止。
- **只看有變化的畫面**：靜止的畫面不送；換場立刻留一格、持續動態累積到一定量才留一格；幾格拼成一張圖再交給模型。
- **不用輪詢**：何時讓模型看由插件的計時器決定，只在 Agent 閒著時才送，不打斷它說話。

## 原理

1. **擷取**：[`@screen-capture/node`](https://github.com/tux-tn/node-screen-capture)（Windows Graphics Capture、macOS ScreenCaptureKit、Linux Wayland ScreenCast Portal）。可以看整個螢幕或單一視窗；系統依取樣頻率送出原始 BGRA 像素，不經過 ffmpeg 或 Python。
2. **變化分**：每一幀在 64×36 的網格上取樣，換算亮度與色差，和上一幀比較，得到平均變化與「變化面積」。大面積的變化是換場；小面積的變化累積起來算動態。整張計算只讀幾千個像素。
3. **挑幀**：換場的那一幀一定留下（太接近上一格時，等到間隔夠了再留）；持續動態累積到門檻留一格；兩格至少隔 0.7 秒。
4. **出圖時機**：格數滿了、最舊的一格超過 20 秒，或換場後畫面穩定 1.2 秒，而且 Agent 閒著、距離上一張至少 10 秒。
5. **Agent 忙的時候**：留下的畫面先存著（最多四張圖的量，太多時從最擠的那段時間拿掉）。出圖時保留最舊與最新的一格，其餘依時間平均挑選，換場優先；並告訴模型中間省略了幾個畫面。不用「變化分最高」來挑，是因為實測時兩種相近顏色之間的切換分數總是最低，那兩個場景每次都被丟掉，模型因此以為它們消失了。
6. **拼圖**：每格縮成 448 寬（區域平均，不放大）。三格以內排成一排，四格 2×2，更多時每排三格，空格以灰色斜線填滿，並告訴模型那不是畫面。左上角標著序號與經過的時間；畫面在最後一格之後還有變化時，補上當下的一格並標 NOW。尺寸對齊模型的影像切塊（預設 28px），不付半塊的錢；四格約 896×504、JPEG 約 50 KB。
7. **送進對話**：拼圖存成 DSH 附件，以 `live-sight` 來源送進對話，並說明「這是即時畫面，不是對方說的話；想說就說，沒有想說的也可以不說」。你在懸浮窗打的字以你的名義送出，並附上當下的畫面。

變化分、多格拼圖與「插件計時、模型不輪詢」的想法參考了 [dsh-see-now](https://github.com/SAOS-3624/dsh-see-now)；喚醒與穩定判斷沿用 dsh-fount-reality 的經驗。程式是重新寫的。

## 安裝

從 [Releases](https://github.com/win10ogod/dsh-live-sight/releases) 下載 `dsh-live-sight-0.1.0.tgz`，放在固定的位置（例如整合包的 `plugin-cache`），再安裝：

```powershell
dsh plugin --profile <整合包 ID> add -w file:C:/path/to/dsh-live-sight-0.1.0.tgz
```

不要直接用 release 的下載網址安裝：GitHub 會轉到一個約一小時後失效的簽章網址，pnpm 把它記進 `package.json`，之後安裝別的插件時會下載失敗。

重新啟動 DSH。需要 DSH 0.2.2-alpha.2 或 0.2.2-rc.1。懸浮窗目前只在 Windows 上有（Windows PowerShell 與 WPF，系統內建）；其他平台照常可以看螢幕，對話留在 DSH 裡。

### 模型要能看圖

這段對話用的模型必須接受圖片輸入，否則 `/sight` 會直接告訴你原因。DeepSeek 的 `deepseek-flash` 可以；`deepseek-v4-pro` 只吃文字。本地模型要在 profile 的 `cordis.patch.yml` 宣告圖片輸入，例如 vLLM 上的 Qwen：

```yaml
- id: llm-pi-ai
  config:
    providers:
      local:
        api: openai-completions
        baseURL: http://localhost:8000/v1
        apiKeyEnv: LOCAL_LLM_API_KEY
        models:
          - id: Qwen3.8-Flash-Next
            contextWindow: 262144
            input: [text, image]
```

## 使用

在對話中輸入：

| 指令 | 作用 |
| --- | --- |
| `/sight` | 開始陪你看主螢幕 |
| `/sight window 原神` | 只看標題含有「原神」的視窗 |
| `/sight foreground` | 下指令後 3 秒內切到要看的視窗，就看那一個 |
| `/sight screen 2` | 看第二個螢幕 |
| `/sight pause`、`/sight resume` | 暫停、繼續（暫停時不擷取畫面） |
| `/sight off` | 停止並關閉懸浮窗 |
| `/sight status` | 目前狀態 |

也可以直接跟 Agent 說「陪我玩」「看一下我的畫面」，它會用 `sight` 工具：

- `look`：看一次現在的畫面（可指定 `target`、`region`、`width`）。回傳的 `scale` 把圖片座標換回畫面座標，`geometry` 是視窗此刻在螢幕上的位置（視窗移動過也是最新的），操作電腦前先用它看清楚。
- `start`、`stop`、`pause`、`resume`、`status`：控制陪看。
- `windows`：列出可以看的視窗標題。

選好的視窗會一直跟著（以視窗代號記住），暫停、繼續或你切去別的視窗都不會換掉；視窗關掉時陪看就停止，懸浮窗會顯示原因。

懸浮窗：拖曳標題列移動，右下角調整大小；右上角依序是暫停／繼續、收合成一行字幕、停止陪伴。輸入框按 Enter 或右邊的箭頭送出，Shift+Enter 換行。回覆中的粗體照樣顯示為粗體。位置與大小會記住（`<DSH_HOME>/storages/live-sight/overlay.json`）。

## 設定

在 profile 的 `cordis.patch.yml`：

```yaml
- id: live-sight
  name: dsh-live-sight
  config:
    overlayTitle: 小夜       # 懸浮窗標題，例如陪你的人的名字
    fps: 2                  # 每秒取樣幾幀
    minGapMs: 10000         # 兩張圖之間至少隔多久
```

| 欄位 | 預設 | 意思 |
| --- | --- | --- |
| `fps` | 2 | 每秒取樣幾幀 |
| `minGapMs` | 10000 | 兩張圖之間至少隔多久（毫秒） |
| `maxFrames` | 6 | 一張圖最多幾格 |
| `maxAgeMs` | 20000 | 最舊的一格超過這麼久就送出 |
| `settleMs` | 1200 | 換場後畫面穩定多久就送出 |
| `motionQuota` | 0.35 | 持續動態累積多少變化留一格 |
| `cutCoverage` | 0.3 | 多大面積同時變化算換場 |
| `tileWidth` | 448 | 每格寬度 |
| `align` | 28 | 模型的影像切塊大小；DeepSeek-V4 可用 42 |
| `lookWidth` | 1344 | `look` 回傳的圖片寬度 |
| `attachWidth` | 896 | 懸浮窗發話時附上的畫面寬度 |
| `overlay` | true | 是否顯示懸浮窗 |
| `overlayTitle` | Live Sight | 懸浮窗標題 |
| `overlayCapturable` | false | 讓擷取畫面看得到懸浮窗（包括 Agent 自己看的畫面、錄影與螢幕分享） |
| `foregroundDelayMs` | 3000 | `foreground` 等多久才取最前面的視窗 |

## 隱私

- 只有你下 `/sight` 或請 Agent 開始時才擷取；暫停與停止時擷取完全關閉。
- 畫面只送給這段對話所用的模型。用本地模型時不離開你的電腦；用雲端模型時會送到該服務。
- 送出的拼圖會存成 DSH 附件（`<DSH_HOME>/attachments`），和你在對話中貼的圖片一樣。
- 擷取時不顯示系統的黃色框線；懸浮窗的綠燈表示正在看，黃燈表示暫停。
- 懸浮窗預設不出現在任何擷取畫面中（Windows 10 2004 以後）：Agent 看整個螢幕時不會讀到自己說的話，錄影或螢幕分享也看不到它。要讓它出現，設定 `overlayCapturable: true`。

## 限制

- 懸浮窗只支援 Windows。macOS 需要「螢幕錄製」權限；Linux 只支援 Wayland（第一次會由系統詢問要分享哪個畫面），而且需要 PipeWire 的函式庫 `libpipewire-0.3`（一般桌面已經有）。
- 遊戲用「獨佔全螢幕」時，任何懸浮窗都蓋不上去；請改用「無邊框視窗」或視窗模式。
- 不聽聲音、不念出回覆。
- 看得到的是取樣下來的畫面，不是連續影片；非常短暫的畫面可能被略過。
- 長時間陪看時，DSH 會在圖片超過上限時把最舊的圖換成文字，這是 DSH 的機制。

## 開發

```sh
npm install
npm test
```

`test/core.test.mjs` 測變化分、挑幀與拼圖；`test/companion.test.mjs` 用替身測陪伴迴圈；`test/dsh.test.mjs` 在真的 DSH 0.2.2-rc.1 組合裡測工具、指令、拼圖送進對話與懸浮窗同步（模型、螢幕與懸浮窗是替身）。CI 另外在 Windows 上檢查 `overlay/overlay.ps1` 能被 Windows PowerShell 5.1 解析。

### 實機測試（2026-11-13，Windows 11、DSH 0.2.2-alpha.2 整合包、本地 vLLM Qwen3.8-Flash-Next）

- 測試畫面是一個每 9～12 秒換場的視窗。`/sight window …` 之後約 3.6 秒送出第一張拼圖。3 分鐘內 8 個回合，每回合約 22～30 秒；Agent 多數時候開口，也有選擇不說的回合。
- 從懸浮窗送出的問題（以 UI Automation 輸入並按送出鈕）以使用者的身分進入對話，附上 896×504 的當下畫面；回覆出現在懸浮窗。
- 實測發現並修正的問題：三格排成 2×2 時的黑色空格被模型說成「畫面變黑」；依變化分丟格使兩個場景一直被丟掉；懸浮窗的 Markdown 粗體顯示成星號。

## 授權

MIT
