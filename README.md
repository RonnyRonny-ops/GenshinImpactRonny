# Genshin Guess · RonnyHarbinger

Game đoán **nhạc OST** và **chiêu nộ** Genshin Impact, chơi real-time cùng người xem livestream.
Người chơi vào bằng link hoặc mã phòng 6 ký tự, không cần tài khoản.

---

## 1. Đưa web lên mạng (miễn phí, khoảng 10 phút)

### Bước 1: Tạo tài khoản GitHub
Vào https://github.com và đăng ký tài khoản (miễn phí).

### Bước 2: Tải code lên GitHub
1. Đăng nhập GitHub, bấm dấu **+** (góc trên bên phải), chọn **New repository**.
2. Đặt tên `genshin-guess` và để **Public**. Bấm **Create repository**.
3. Trên trang repo mới, bấm dòng chữ **uploading an existing file**.
4. Giải nén file zip mình gửi, rồi kéo **toàn bộ file và thư mục bên trong** (`server.js`, `package.json`, `render.yaml`, thư mục `public`, …) thả vào trang.
   **Đừng** tải lên thư mục `node_modules` nếu có.
5. Bấm **Commit changes**.

### Bước 3: Chạy web trên Render
1. Vào https://render.com và bấm **Get Started**. Chọn **Sign in with GitHub**.
2. Bấm **New +**, chọn **Blueprint**, rồi chọn repo `genshin-guess`. Render tự đọc file `render.yaml`.
3. Bấm **Apply** và chờ khoảng 2–3 phút.
4. Khi có chữ **Live**, bạn sẽ có link dạng `https://genshin-guess-xxxx.onrender.com`. Đây là link game của bạn.

> **Lưu ý gói miễn phí của Render:** web tự "ngủ" sau 15 phút không ai vào, lần mở đầu tiên sau đó mất khoảng 1 phút để thức dậy.
> **Mẹo:** trước khi lên live 5 phút, bạn tự mở link game một lần là được.
> Phòng chơi chỉ lưu trên máy chủ trong lúc đang chơi; máy chủ khởi động lại thì phải tạo phòng mới.

---

## 2. Chuẩn bị thư viện (làm một lần)

Mở link game, bấm **Thư viện của tôi**.

**Nhạc OST:**
- Lên YouTube tìm playlist OST Genshin, copy link playlist (có `list=` trong link), dán vào ô rồi bấm **Thêm vào thư viện**.
- App tự lấy tên bài. Bài nào YouTube không cho phát trên web khác sẽ bị bỏ qua.
- Bấm **Làm gọn tên** để bỏ các chữ thừa như "Genshin Impact OST". Bạn có thể sửa tay từng tên; tên này chính là đáp án người chơi nhìn thấy.
- Ưu tiên playlist từ kênh chính thức **HOYO-MiX** / **Genshin Impact**.

**Chiêu nộ:**
- Nhập tên nhân vật (VD: *Băng Thần*), chọn ảnh chụp chiêu nộ từ máy (chọn được nhiều ảnh), rồi bấm **Thêm ảnh**.
- Cần ít nhất **2 nhân vật khác nhau** mới chơi được. Càng nhiều nhân vật thì càng vui.
- Mẹo: chụp đúng khoảnh khắc đặc trưng nhất của chiêu, không chụp lúc có chữ tên nhân vật hiện trên màn hình.

Thư viện được lưu trên **trình duyệt bạn đang dùng**. Vào tab **Sao lưu** và bấm **Xuất file thư viện** để giữ bản dự phòng hoặc chuyển sang máy khác.

---

## 3. Lên live

1. Mở link game trên máy tính, nhập tên, bấm **Tạo phòng mới**.
2. Chọn chế độ: **Đoán nhạc OST**, **Đoán chiêu nộ** hoặc **Trộn cả hai**. Chỉnh số vòng và số giây.
3. Trong OBS hoặc TikTok Live Studio, thêm cửa sổ trình duyệt này (Window Capture). Màn hình có sẵn **mã phòng**, **mã QR** và **bảng xếp hạng**.
4. Người xem quét QR hoặc vào link, nhập mã phòng và tên. Họ chơi ngay trên điện thoại.
5. Bấm **Bắt đầu**.

**Âm thanh khi live:** nhạc phát trong trình duyệt của bạn, nên trong OBS hãy bật thu tiếng trình duyệt (Desktop Audio hoặc Application Audio Capture). Người chơi cũng nghe nhạc trên máy của họ, đồng bộ cùng lúc.

**Cách tính điểm:**
- Trả lời đúng được 400 đến 1000 điểm, càng nhanh càng nhiều.
- Đúng liên tiếp được thưởng thêm, tối đa +200 điểm mỗi vòng.

**Nút của chủ phòng:**
- **Bỏ qua / Tiếp:** sang vòng tiếp theo.
- **Về phòng chờ:** dừng ván đang chơi.
- **✕** cạnh tên người chơi: mời người đó ra khỏi phòng.

---

## 4. Chạy thử trên máy (không bắt buộc)

Cần cài Node.js 18 trở lên. Mở terminal trong thư mục này rồi chạy:
```
npm install
npm start
```
Sau đó mở http://localhost:3000

## Bản quyền
Nhạc phát qua trình phát YouTube chính thức (không tải hay lưu file nhạc). Hình ảnh nhân vật và chiêu nộ là tài sản của HoYoverse, chỉ dùng cho mục đích giải trí, phi thương mại.
