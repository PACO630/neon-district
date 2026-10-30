# NEON DISTRICT

無伺服器（純靜態 + WebRTC P2P）的多人 3D 賽博龐克城市與 C4 爆破戰術射擊遊戲。可直接部署到 GitHub Pages。

- 城市大廳與競技場皆為**第一人稱視角**。
- 介面支援 **English / 繁體中文 / 日本語**（主選單右上角或設定中切換，會記在此瀏覽器）。

## 部署
1. 建立 GitHub repo，推上 `main` 分支。
2. Repo → Settings → Pages → Source 選 **GitHub Actions**。
3. `.github/workflows/deploy.yml` 會自動 `npm ci && npm run build` 並發佈 `dist/`。`vite.config.ts` 使用 `base: './'`，任何子路徑皆可運作。

本機開發：`npm install`、`npm run dev`；重新產生 GLB 模型：`npm run models`。

## 如何連線（沒有信令伺服器）
1. 房主：PLAY → Host a room → 進入城市後開 **ROOM · INVITES** → New invite（每位朋友一個，單次有效）。
2. 用複製 / QR Code / 檔案把 INVITE 傳給朋友；朋友在 PLAY → Join 貼上，產生 **REPLY**。
3. 朋友把 REPLY 傳回，房主貼到同一個邀請槽按 Connect。之後其他玩家之間會透過房主自動轉送信令，建立 Full Mesh 直連。
- 只使用公開 STUN，沒有 TURN：對稱型 NAT / 部分行動網路可能無法直連，請改用同一 Wi-Fi 或其他網路。
- 房間只存在於玩家瀏覽器中；所有人離開即消失。

## 操作
PC：WASD、滑鼠、左鍵射擊、右鍵瞄準、R 換彈、Shift 慢走、Space 跳、Ctrl/C 蹲、1–5 武器、E 互動、B 購買、G 丟 C4、Tab 計分板、Enter 聊天、Z/X 表情、Esc 選單。
手機（橫向）：左側虛擬搖桿、右側滑動視角、FIRE/AIM/R/⇄/CRCH/JUMP/USE/BUY/TAB 按鈕。網址加 `?touch` 可強制觸控介面。

## 架構
`src/networking`（二進位序列化、WebRTC PeerLink、手動信令、Mesh、Snapshot Delta 壓縮）、`src/room`（房間狀態、房主權威、隊伍、房主移交）、`src/arena`（SECTOR 09 地圖資料、MatchHost 權威模擬、客戶端）、`src/city`、`src/engine`（PBR 程序貼圖、平面反射濕地、雨、霧、光束、後處理）、`src/combat`、`src/ui`、`src/audio`、`src/mobile`。

## 已驗證
兩個 / 三個瀏覽器分頁實際 WebRTC 連線、聊天與位置同步、Full Mesh、組隊、購買與金錢同步、命中 / 擊殺 / 回合結算、C4 安裝與拆除、比賽中房主斷線移交（epoch 2 接手並恢復比賽）、三人房主移交後其餘玩家維持連線。

## 素材授權（Credits）
角色與槍械模型皆為 **CC0（公有領域）**，作者 **Quaternius**，經由 [Poly Pizza](https://poly.pizza) 下載，位於 `public/models/cc0/`：
SWAT、Animated Woman（角色，含 Idle_Gun / Run_Shoot / 側移 / Death 等動畫）、Pistol、Long Pistol、Submachine Gun、Assault Rifle、Bullpup、Sniper Rifle、Shotgun、Knife。
C4 與投擲物仍由 `tools/build-models.mjs` 程序化產生（`public/models/weapons.glb`）。

## 誠實說明與限制
- **3D 模型**：CC0 模型為低多邊形風格（Quaternius），比真實寫實風格簡化；角色沒有蹲下動畫，蹲姿為程式即時彎曲腿部骨骼。
- **貼圖**：PBR 貼圖（Base/Normal/Roughness/Metalness/AO/Emissive）在執行時程序生成，因此沒有 KTX2 壓縮貼圖資產。
- **音效**：全部以 Web Audio 即時合成，沒有錄音檔。
- **反射**：使用平面反射 + Reflection Probe（CubeCamera），未實作 SSR。動態模糊僅處理鏡頭旋轉。
- **V-Sync**：瀏覽器無法關閉，設定頁以 FPS 上限代替。
- **反作弊**：房主權威只能拒絕明顯不合理的輸入（速度、射速、彈藥、距離），不等於伺服器端防作弊。
- **房主移交**為最佳努力：快照過舊會重開回合；無人可接手則房間安全關閉。只連到舊房主、尚未建立 mesh 的玩家會斷線，需重新邀請。
- 跨裝置（實體手機 ↔ PC、iOS Safari）尚未在實機上測試，只在桌面瀏覽器分頁與行動視窗模擬中驗證。
- **多國語言**：介面文字以自動翻譯層套用（MutationObserver），武器型號等專有名詞保留英文；城市招牌是場景內的裝飾文字，不隨語言變動。
- 城市大廳的視覺方向參考夜之城風格的賽博龐克氛圍，但所有建築、招牌、品牌名稱都是原創，不使用任何其他遊戲的素材。
