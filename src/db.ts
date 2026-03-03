import axios from 'axios';

// Định nghĩa URL Backend Laravel của bạn
// Bạn có thể sau này đưa vào file .env hoặc cấu hình config
const LARAVEL_API_URL = 'https://manager.felineez.com/api/save-tiktok-data';
// const LARAVEL_API_URL = 'http://127.0.0.1:8008/api/save-tiktok-data';
const API_SECRET_KEY = 's1642002abc123@';

export interface SaveProfileData {
    profileId: string;
    profileName: string;
    sellerId?: string;
    bankAccountNumber?: string;
    beneficiaryName?: string;
    netEarning?: string;
    onHoldAmount?: string;
    sumAmount?: string;
    monthlyData?: { month: string; settlement: string }[];
    status?: 'success' | 'failed' | 'timeout' | 'not_logged_in';
    errorMessage?: string;
    durationMs?: number;
}

export async function saveTikTokDataToDB(data: SaveProfileData) {
    console.log(`[API] → Calling Laravel API for profile: ${data.profileId} | status: ${data.status} | URL: ${LARAVEL_API_URL}`);
    try {
        // Gửi toàn bộ dữ liệu qua Backend Laravel để Laravel tự xử lý lưu Database
        const response = await axios.post(
            LARAVEL_API_URL,
            data,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${API_SECRET_KEY}`
                },
                timeout: 15000
            }
        );

        if (response.data && response.data.success) {
            console.log(`[API] ✓ Saved profile: ${data.profileId}`);
        } else {
            console.error(`[API] ⚠ Backend error for ${data.profileId}:`, response.data);
        }

    } catch (error: any) {
        let serverMsg = error.message;
        if (error.response && error.response.data) {
            serverMsg = JSON.stringify(error.response.data);
        }
        console.error(`[API] ✗ Failed for ${data.profileId}: ${serverMsg}`);
    }
}
