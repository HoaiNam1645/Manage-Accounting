# 🚀 Auto-Update & Distribution Guide

## Tổng quan

App sử dụng **Electron Forge + GitHub Releases** để phân phối và auto-update.

```
Bạn push code + tag → GitHub Actions tự build (Win + Mac) → Upload lên GitHub Releases
                                                                    ↓
Website (manager.felineez.com) → Link tải trỏ đến GitHub Releases ←┘
                                                                    ↓
App trên máy user → Tự check update mỗi 10 phút → Download & cài đặt tự động
```

---

## ⚠️ YÊU CẦU QUAN TRỌNG: Repo phải PUBLIC

`update-electron-app` sử dụng service `https://update.electronjs.org` - service này **chỉ hoạt động với public repos**.

Nếu repo hiện tại là **private**, bạn cần chuyển sang **public**:
1. Vào GitHub → Settings → General → Danger Zone → Change visibility → **Public**

> 💡 Lưu ý: File `.env` đã nằm trong `.gitignore` nên sẽ không bị push lên.

---

## Cách release phiên bản mới

### Bước 1: Cập nhật version trong package.json

```bash
# Tăng version (tự động update package.json + tạo git tag)
npm version patch   # 1.0.0 → 1.0.1 (bug fix nhỏ)
npm version minor   # 1.0.0 → 1.1.0 (thêm feature)
npm version major   # 1.0.0 → 2.0.0 (breaking changes)
```

### Bước 2: Push code + tag lên GitHub

```bash
git push origin main
git push origin --tags
```

### Bước 3: GitHub Actions tự động

- Build cho **Windows** (`.exe` squirrel installer)
- Build cho **macOS** (`.zip`)
- Upload lên **GitHub Releases** (draft mode)

### Bước 4: Publish release

1. Vào GitHub → Releases
2. Bạn sẽ thấy một **Draft release** mới
3. Review, thêm release notes nếu cần
4. Click **"Publish release"**

### Bước 5: User nhận update

- App tự kiểm tra mỗi **10 phút**
- Khi có version mới → hiện dialog hỏi user có muốn restart & update không
- User click **"Restart"** → App tự cập nhật

---

## Thêm link tải trên website manager.felineez.com

Thêm link download trỏ đến GitHub Releases page:

```html
<!-- Link tải chung (trang releases) -->
<a href="https://github.com/HoaiNam1645/Manage-Accounting/releases/latest">
    Download Latest Version
</a>

<!-- Hoặc link trực tiếp cho từng platform -->
<!-- Windows (.exe) - tên file tuỳ vào tên app sau khi build -->
<a href="https://github.com/HoaiNam1645/Manage-Accounting/releases/latest/download/hidemyacc-runner-1.0.0-Setup.exe">
    Download for Windows
</a>

<!-- macOS (.zip) -->
<a href="https://github.com/HoaiNam1645/Manage-Accounting/releases/latest/download/hidemyacc-runner-darwin-x64-1.0.0.zip">
    Download for macOS
</a>
```

> 📌 Tên file chính xác sẽ có sau lần build đầu tiên. Sau đó bạn có thể dùng GitHub API để tự detect tên file.

---

## Lần đầu release (test thử)

```bash
# 1. Commit tất cả thay đổi
git add -A
git commit -m "feat: add auto-update support"

# 2. Đặt version
npm version 1.0.1

# 3. Push
git push origin main
git push origin --tags

# 4. Xem GitHub Actions build tại:
# https://github.com/HoaiNam1645/Manage-Accounting/actions
```

---

## Build thủ công (local - nếu cần)

```bash
# Build cho Windows (từ Mac, cần cross-compilation tools)
npm run make -- --platform=win32 --arch=x64

# Build cho macOS
npm run make -- --platform=darwin --arch=x64

# Publish lên GitHub (cần GITHUB_TOKEN)
GITHUB_TOKEN=your_token npx electron-forge publish
```

---

## Troubleshooting

### Q: Repo private, auto-update không hoạt động?
**A:** Chuyển repo sang public, hoặc self-host update server.

### Q: Windows SmartScreen block app?
**A:** App chưa được code-sign. User cần click "More Info" → "Run anyway". Để tránh, cần mua Windows code signing certificate (~$200/năm).

### Q: macOS báo "unidentified developer"?
**A:** User cần: System Preferences → Security → "Open Anyway". Hoặc mua Apple Developer certificate ($99/năm).

### Q: GitHub Actions build fail?  
**A:** Check Actions tab trên GitHub. Thường do thiếu `GITHUB_TOKEN` (đã có sẵn mặc định) hoặc native modules không build được trên CI.
