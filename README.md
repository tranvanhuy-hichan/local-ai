# Local AI Chat

Ứng dụng desktop kiểu ChatGPT để trò chuyện với các model AI chạy **hoàn toàn trên máy của bạn** thông qua [Ollama](https://ollama.com). Xây dựng bằng Electron, không gửi dữ liệu ra ngoài.

## Tính năng

- Chat streaming theo thời gian thực, có nút dừng.
- Chọn model Ollama đã cài; hiển thị khả năng của model (ví dụ vision).
- Bật/tắt model: nạp vào hoặc giải phóng bộ nhớ (RAM/VRAM) ngay trong giao diện.
- Đính kèm ảnh và tệp: PDF, DOCX, và các tệp văn bản/mã nguồn (txt, md, csv, json, py, js, ...). Nội dung được trích xuất rồi đưa cho model (tối đa 300.000 ký tự mỗi tệp).
- Lịch sử đoạn chat, tìm kiếm đoạn chat, lưu cục bộ trong thư mục dữ liệu của ứng dụng.
- Cài đặt: ngôn ngữ trả lời (Tiếng Việt / English / tự động), system prompt, temperature.
- Xuất đoạn chat ra file Markdown (`.md`).

## Yêu cầu

- Linux (đã thử nghiệm trên Ubuntu; chạy qua XWayland)
- [Node.js](https://nodejs.org) và npm
- [Ollama](https://ollama.com) đã cài đặt, và ít nhất một model, ví dụ:

```bash
ollama pull llama3.2
```

## Cài đặt và chạy

```bash
git clone https://github.com/tranvanhuy-hichan/local-ai.git
cd local-ai
npm install
npm start
```

Ollama cần đang chạy (`ollama serve`). Nếu Ollama ở địa chỉ khác, đặt biến môi trường `OLLAMA_HOST`, ví dụ:

```bash
OLLAMA_HOST=http://192.168.1.10:11434 npm start
```

### Script khởi động nhanh

`local-ai.sh` tự bật Ollama nếu chưa chạy rồi mở ứng dụng. Script đang dùng đường dẫn tuyệt đối tới thư mục dự án, hãy sửa lại cho khớp với máy của bạn trước khi dùng.

## Đóng gói

```bash
npm run dist
```

Tạo file `.AppImage` và `.deb` trong thư mục `dist/`.

## Cấu trúc dự án

| Đường dẫn | Mô tả |
|---|---|
| `main.js` | Tiến trình chính Electron: gọi API Ollama, streaming, trích xuất tệp, lưu dữ liệu |
| `preload.js` | Cầu nối IPC an toàn (`contextIsolation`) giữa giao diện và tiến trình chính |
| `renderer/` | Giao diện (HTML, CSS, JS thuần) |
| `build/` | Icon ứng dụng |
| `local-ai.sh` | Script khởi động nhanh |

## Ghi chú

- Giao diện dùng tiếng Việt.
- GPU của giao diện bị tắt (tránh lỗi cửa sổ trắng với NVIDIA + Wayland); Ollama vẫn dùng GPU bình thường để chạy model.
- PDF dạng ảnh scan không trích xuất được chữ.
