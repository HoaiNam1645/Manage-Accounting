import { app, BrowserWindow, ipcMain, screen } from 'electron';
import * as path from 'path';
import axios from 'axios';
import puppeteer from 'puppeteer-core';
import { loginTikTokSeller } from './tiktok-login';
import { getCredentialsByProfileId, getCredentialsByProfileName, readAllCredentials, loadCredentialsFromExcel, loadCredentialsFromExcelBuffer } from './credentials-reader';

const API_BASE = 'http://127.0.0.1:2268';

let mainWindow: BrowserWindow | null = null;

// Window arrangement tracking - use Set to avoid race conditions
const usedWindowPositions = new Set<number>();
const MAX_WINDOWS = 5; // Grid layout for 5 windows

function getNextWindowPosition(): number {
    for (let i = 0; i < MAX_WINDOWS; i++) {
        if (!usedWindowPositions.has(i)) {
            usedWindowPositions.add(i);
            return i;
        }
    }
    // All positions used, wrap around
    return 0;
}

function releaseWindowPosition(index: number): void {
    usedWindowPositions.delete(index);
}

// Interfaces
interface ProfileProxy {
    proxyEnabled: boolean;
    mode: string;
    autoProxyRegion?: string;
}

interface Profile {
    id: string;
    name: string;
    notes: string;
    browserSource: string;
    browserType: string;
    proxy: ProfileProxy;
}

interface ApiResponse<T> {
    code: number;
    data: T;
}

interface StartProfileData {
    success: boolean;
    port: number;
    wsUrl: string;
    userAgent: string;
    majorVersion: number;
}

// ============================================
// TIKTOK DATA FETCHER - Puppeteer Integration
// ============================================

interface TikTokFinanceResult {
    sellerId: string;
    oecSellerId: string;
    financeData: any;
    paymentData?: any;
    monthlyData?: { date_time_lower: number; date_time_upper: number; settlement: string }[];
    summary?: {
        onHoldAmount: string;
        sumAmount: string;
        monthly?: { date_time_lower: number; date_time_upper: number; settlement: string }[];
    };
    profileName?: string;
}

/**
 * Extract seller_id từ URL của API call
 */
function extractSellerIdFromUrl(url: string): { sellerId: string; oecSellerId: string } | null {
    try {
        const urlObj = new URL(url);
        const sellerId = urlObj.searchParams.get('seller_id');
        const oecSellerId = urlObj.searchParams.get('oec_seller_id');

        if (sellerId && oecSellerId) {
            return { sellerId, oecSellerId };
        }
    } catch (e) {
        // Invalid URL, ignore
    }
    return null;
}

// ============================================
// HYBRID APPROACH - Fast Direct API Call
// ============================================
// Note: TikTok login functions are in ./tiktok-login.ts

interface CookieData {
    name: string;
    value: string;
    domain: string;
}

/**
 * FAST HYBRID: Extract cookies + seller_id từ browser, sau đó gọi API trực tiếp
 * Flow:
 * 1. Connect browser, navigate đến TikTok seller center (bất kỳ trang nào)
 * 2. Bắt seller_id từ network request
 * 3. Extract cookies
 * 4. ĐÓNG BROWSER NGAY (gọi Hidemyacc Stop API)
 * 5. Dùng axios + cookies để gọi Finance API trực tiếp
 * 
 * @param debugPort - Port debug của browser
 * @param profileId - ID của profile để gọi stop API
 */
async function fetchTikTokDataFast(debugPort: number, profileId: string): Promise<TikTokFinanceResult> {
    console.log(`[Fast] Connecting to browser on port ${debugPort}...`);

    let browser: any = null;
    let page: any = null;
    let cookies: CookieData[] = [];
    let sellerId = '';
    let oecSellerId = '';
    let lastNetworkError = ''; // Lưu lỗi mạng cụ thể

    try {
        // Bước 1: Kết nối browser
        browser = await puppeteer.connect({
            browserURL: `http://127.0.0.1:${debugPort}`,
            defaultViewport: null
        });
        console.log('[Fast] ✓ Connected to browser');

        page = await browser.newPage();

        // Bước 2: Setup listener bắt seller_id từ network
        let sellerInfo: { sellerId: string; oecSellerId: string } | null = null;
        let foundSource = '';

        const networkPromise = new Promise<void>((resolve) => {
            page.on('response', async (response: any) => {
                if (sellerInfo) return; // Đã tìm thấy
                const url = response.url();
                if (url.includes('seller-us.tiktok.com') && url.includes('seller_id=')) {
                    const extracted = extractSellerIdFromUrl(url);
                    if (extracted) {
                        sellerInfo = extracted;
                        foundSource = 'Network Request';
                        resolve();
                    }
                }
            });
        });

        // Navigate đến Homepage
        console.log('[Fast] Navigating to TikTok Seller Center...');
        await page.goto('https://seller-us.tiktok.com/finance/bills?lng=en&shop_region=US&subTab=on-hold&tab=overview', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        // Bước 2.1: Chủ động tìm seller_id ngay lập tức (Logic "Săn mồi")
        // Bước 2.1: Chủ động tìm seller_id ngay lập tức (Logic "Săn mồi")
        const deadline = Date.now() + 30000; // Tăng timeout lên 30s cho chắc

        // Chờ 2s để trang ổn định sau khi goto
        await new Promise(r => setTimeout(r, 2000));

        while (!sellerInfo && Date.now() < deadline) {
            try {
                // Cách 1: Check URL hiện tại
                if (page.isClosed()) break;
                const currentUrl = page.url();
                if (currentUrl.includes('seller_id=')) {
                    sellerInfo = extractSellerIdFromUrl(currentUrl);
                    if (sellerInfo) {
                        foundSource = 'Current URL';
                        break;
                    }
                }

                // Cách 2: Check DOM (atlas-data / __NEXT_DATA__)
                const pageData = await page.evaluate(() => {
                    try {
                        const atlasDiv = document.getElementById('atlas-data');
                        if (atlasDiv && atlasDiv.textContent) {
                            const data = JSON.parse(atlasDiv.textContent);
                            if (data?.seller?.seller_id) return { id: data.seller.seller_id, src: 'atlas-data' };
                        }
                        const nextDiv = document.getElementById('__NEXT_DATA__');
                        if (nextDiv && nextDiv.textContent) {
                            const str = nextDiv.textContent;
                            const match = str.match(/"seller_id":"(\d+)"/);
                            if (match && match[1]) return { id: match[1], src: '__NEXT_DATA__' };
                        }
                    } catch (e) { }
                    return null;
                });

                if (pageData) {
                    sellerInfo = { sellerId: pageData.id, oecSellerId: pageData.id };
                    foundSource = `Page Content (${pageData.src})`;
                    break;
                }
            } catch (err: any) {
                // Ignore lỗi context destroyed khi trang đang reload/redirect
            }

            // Chờ 1 chút trước khi thử lại
            await new Promise(r => setTimeout(r, 1000));
        }

        if (!sellerInfo) {
            throw new Error('Timeout: Could not find seller_id in Network, URL, or Page Content');
        }

        console.log(`[Fast] ✓ Got seller_id: ${sellerInfo.sellerId} (via ${foundSource})`);

        // FIX: Gán giá trị vào biến outer scope (không dùng const/let ở đây)
        sellerId = sellerInfo.sellerId;
        oecSellerId = sellerInfo.oecSellerId;

        // Bước 3: Extract cookies
        cookies = await page.cookies('https://seller-us.tiktok.com');
        console.log(`[Fast] ✓ Extracted ${cookies.length} cookies`);

        // Bước 4: Disconnect Puppeteer
        await page.close();
        await browser.disconnect();
        console.log('[Fast] ✓ Puppeteer disconnected');

    } catch (error: any) {
        const errorMsg = error.message || '';
        console.error('[Fast] Browser error:', errorMsg);

        // Lưu lỗi cụ thể để throw sau
        if (errorMsg.includes('ERR_PROXY_CONNECTION_FAILED')) {
            lastNetworkError = '⚠ Proxy dead/unavailable';
        } else if (errorMsg.includes('ERR_TIMED_OUT')) {
            lastNetworkError = '⚠ Network timeout';
        } else if (errorMsg.includes('ERR_CONNECTION_REFUSED')) {
            lastNetworkError = '⚠ Connection refused';
        } else if (errorMsg.includes('ERR_NAME_NOT_RESOLVED')) {
            lastNetworkError = '⚠ DNS resolution failed';
        }

        // Cleanup Puppeteer
        if (page) try { await page.close(); } catch (e) { }
        if (browser) try { await browser.disconnect(); } catch (e) { }
    }

    // Bước 4.5: GỌI API STOP ĐỂ ĐÓNG BROWSER HIDEMYACC
    try {
        console.log(`[Fast] Stopping profile ${profileId}...`);
        await axios.post(`${API_BASE}/profiles/stop/${profileId}`);
        console.log('[Fast] ✓ Browser CLOSED via Hidemyacc API');
    } catch (e: any) {
        console.log('[Fast] Warning: Could not stop profile:', e.message);
    }

    // Kiểm tra xem đã lấy được seller_id và cookies chưa
    if (!sellerId || cookies.length === 0) {
        // Throw lỗi mạng cụ thể nếu có
        if (lastNetworkError) {
            throw new Error(lastNetworkError);
        }
        throw new Error('Failed to extract seller_id or cookies');
    }

    // Bước 5: Gọi API trực tiếp bằng axios
    console.log('[Fast] Calling Finance APIs directly...');

    // Build cookie string
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const headers = {
        'Cookie': cookieString,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://seller-us.tiktok.com/finance/bills',
        'Origin': 'https://seller-us.tiktok.com'
    };

    // API 1: Stat Info (On Hold Amount)
    const statApiUrl = `https://seller-us.tiktok.com/api/v1/pay/statement/stat/info?locale=en&language=en&oec_seller_id=${oecSellerId}&seller_id=${sellerId}&app_id=4068&aid=4068&app_name=i18n_ecom_shop&device_platform=web&timezone_name=America%2FLos_Angeles&amount_stat_type=1&statement_version=1`;

    const statResponse = await axios.get(statApiUrl, { headers, timeout: 10000 });
    const financeData = statResponse.data;
    const onHoldAmount = financeData?.data?.to_settle_amount_stat?.amount?.format_with_symbol || 'N/A';

    console.log(`[Fast] ✓ API 1 (Stat Info) - On Hold: ${onHoldAmount}`);

    // API 2: Payment List (Sum Amount - Tổng tiền đã thanh toán)
    const paymentApiUrl = `https://seller-us.tiktok.com/api/v1/pay/statement/payment/list?locale=en&language=en&oec_seller_id=${oecSellerId}&seller_id=${sellerId}&aid=4068&app_name=i18n_ecom_shop&device_platform=web&timezone_name=America%2FLos_Angeles&pagination_type=1&from=0&size=10&need_total_amount=true&page_type=2`;

    let paymentData: any = null;
    let sumAmount = 'N/A';
    try {
        const paymentResponse = await axios.get(paymentApiUrl, { headers, timeout: 10000 });
        paymentData = paymentResponse.data;
        sumAmount = paymentData?.data?.sum_amount?.format_with_symbol || 'N/A';
        console.log(`[Fast] ✓ API 2 (Payment List) - Sum Amount: ${sumAmount}`);
    } catch (e: any) {
        console.log(`[Fast] ⚠ API 2 failed: ${e.message}`);
    }

    // API 3: Monthly Settlement (Tháng hiện tại + các tháng trước + năm ngoái)
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0-indexed (0 = Jan, 1 = Feb, ...)
    const prevYear = currentYear - 1;

    const monthlyData: { date_time_lower: number; date_time_upper: number; settlement: string }[] = [];

    console.log(`[Fast] Fetching monthly data: ${prevYear} (12 months) + ${currentYear} (${currentMonth + 1} months)...`);

    // Helper function để tính timestamp cho 1 tháng (PST timezone)
    const getMonthTimestamps = (year: number, month: number) => {
        // Ngày đầu tháng 00:00:00 PST (UTC-8)
        const startDate = new Date(Date.UTC(year, month, 1, 8, 0, 0));
        // Ngày cuối tháng 23:59:59 PST
        const lastDay = new Date(year, month + 1, 0).getDate(); // Số ngày trong tháng
        const endDate = new Date(Date.UTC(year, month, lastDay, 31, 59, 59, 999));
        return { lower: startDate.getTime(), upper: endDate.getTime() };
    };

    // Helper function để fetch 1 tháng
    const fetchMonth = async (year: number, month: number) => {
        const { lower, upper } = getMonthTimestamps(year, month);
        try {
            const monthlyApiUrl = `https://seller-us.tiktok.com/api/v1/pay/statement/stat/info?locale=en&language=en&oec_seller_id=${oecSellerId}&seller_id=${sellerId}&aid=4068&app_name=i18n_ecom_shop&device_platform=web&timezone_name=America%2FLos_Angeles&amount_stat_type=5&date_time_lower=${lower}&date_time_upper=${upper}&time_type=2&terminal_type=1&statement_version=1`;

            const response = await axios.get(monthlyApiUrl, { headers, timeout: 10000 });
            const settlement = response.data?.data?.finance_report_stat?.total_settlement?.format_with_symbol || '$0';

            return { date_time_lower: lower, date_time_upper: upper, settlement };
        } catch (e: any) {
            return { date_time_lower: lower, date_time_upper: upper, settlement: 'Error' };
        }
    };

    // 1. Lấy 12 tháng năm ngoái (Jan - Dec prevYear)
    for (let month = 0; month < 12; month++) {
        const data = await fetchMonth(prevYear, month);
        monthlyData.push(data);
        if (data.settlement !== '$0' && data.settlement !== 'Error') {
            const monthName = new Date(prevYear, month).toLocaleString('en', { month: 'short' });
            console.log(`[Fast]   ${monthName} ${prevYear}: ${data.settlement}`);
        }
    }

    // 2. Lấy các tháng năm nay (từ Jan đến tháng hiện tại)
    for (let month = 0; month <= currentMonth; month++) {
        const data = await fetchMonth(currentYear, month);
        monthlyData.push(data);
        if (data.settlement !== '$0' && data.settlement !== 'Error') {
            const monthName = new Date(currentYear, month).toLocaleString('en', { month: 'short' });
            console.log(`[Fast]   ${monthName} ${currentYear}: ${data.settlement}`);
        }
    }

    console.log(`[Fast] ✓ API 3 (Monthly) - Done (${monthlyData.length} months)`);
    console.log(`[Fast] ✓ Complete! On Hold: ${onHoldAmount}, Total Paid: ${sumAmount}`);

    return {
        sellerId,
        oecSellerId,
        financeData,
        paymentData,
        monthlyData,
        // Thêm summary cho tiện dùng
        summary: {
            onHoldAmount,
            sumAmount,
            monthly: monthlyData
        }
    };
}

/**
 * Kết nối vào browser Hidemyacc và lấy dữ liệu Finance từ TikTok Seller Center
 * Flow mới:
 * 1. Navigate đến trang Finance
 * 2. Intercept network requests để bắt seller_id
 * 3. Dùng seller_id đó để gọi API stat/info
 * 4. Trả về kết quả
 * 
 * @param debugPort - Port debug của browser (lấy từ Hidemyacc API)
 */
async function fetchTikTokFinanceData(debugPort: number): Promise<TikTokFinanceResult> {
    console.log(`[TikTok] Connecting to browser on port ${debugPort}...`);

    try {
        // Kết nối vào browser đang chạy qua Chrome DevTools Protocol
        const browser = await puppeteer.connect({
            browserURL: `http://127.0.0.1:${debugPort}`,
            defaultViewport: null
        });

        console.log('[TikTok] Connected to browser successfully');

        // Tạo tab mới
        const page = await browser.newPage();

        // Biến lưu seller info khi bắt được
        let sellerInfo: { sellerId: string; oecSellerId: string } | null = null;
        let financeApiData: any = null;

        // Promise để chờ bắt được seller_id VÀ finance data
        const dataPromise = new Promise<TikTokFinanceResult>((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (sellerInfo) {
                    // Có seller_id nhưng không bắt được finance data -> vẫn return
                    resolve({
                        sellerId: sellerInfo.sellerId,
                        oecSellerId: sellerInfo.oecSellerId,
                        financeData: financeApiData || { message: 'Finance API not captured, but seller_id found' }
                    });
                } else {
                    reject(new Error('Timeout: Could not extract seller_id from TikTok (30s)'));
                }
            }, 30000);

            // Lắng nghe tất cả response từ network
            page.on('response', async (response) => {
                const url = response.url();

                // Bắt seller_id từ bất kỳ API call nào của TikTok
                if (!sellerInfo && url.includes('seller-us.tiktok.com') && url.includes('seller_id=')) {
                    const extracted = extractSellerIdFromUrl(url);
                    if (extracted) {
                        sellerInfo = extracted;
                        console.log(`[TikTok] ✓ Extracted seller_id: ${sellerInfo.sellerId}`);
                        console.log(`[TikTok] ✓ Extracted oec_seller_id: ${sellerInfo.oecSellerId}`);
                    }
                }

                // Bắt Finance API response (stat/info) - CHỈ với amount_stat_type=1
                if (url.includes('/api/v1/pay/statement/stat/info') && url.includes('amount_stat_type=1')) {
                    try {
                        const contentType = response.headers()['content-type'] || '';
                        if (contentType.includes('application/json')) {
                            const jsonData = await response.json();

                            // Validate data structure
                            const toSettleAmount = jsonData?.data?.to_settle_amount_stat?.amount?.amount;
                            if (toSettleAmount !== undefined) {
                                financeApiData = jsonData;
                                console.log('[TikTok] ✓ Captured Finance stat/info API (amount_stat_type=1)');
                                console.log(`[TikTok] ✓ Raw On Hold Amount: ${toSettleAmount}`);

                                // Nếu đã có cả seller_id và finance data -> resolve ngay
                                if (sellerInfo) {
                                    clearTimeout(timeout);
                                    resolve({
                                        sellerId: sellerInfo.sellerId,
                                        oecSellerId: sellerInfo.oecSellerId,
                                        financeData: financeApiData
                                    });
                                }
                            } else {
                                console.log('[TikTok] Skipped API response - missing to_settle_amount_stat');
                            }
                        }
                    } catch (e) {
                        console.log('[TikTok] Could not parse finance response as JSON');
                    }
                }
            });
        });

        // Navigate đến trang Finance của TikTok Seller Center
        console.log('[TikTok] Navigating to TikTok Seller Center Finance page...');
        await page.goto('https://seller-us.tiktok.com/finance/bills?lng=en&shop_region=US&subTab=on-hold&tab=overview', {
            waitUntil: 'networkidle2', // Đợi network idle để bắt được nhiều API calls
            timeout: 60000
        });

        // Chờ data
        console.log('[TikTok] Waiting for seller_id and finance data...');
        const result = await dataPromise;

        // Extract giá trị On Hold amount
        const financeData = result.financeData;
        const toSettleAmount = financeData?.data?.to_settle_amount_stat?.amount?.amount || 'N/A';
        const toSettleFormatted = financeData?.data?.to_settle_amount_stat?.amount?.format_with_symbol || 'N/A';
        const settlementDays = financeData?.data?.seller_quality_stat?.bill_finish_period_in_days || 'N/A';
        const reserveLevel = financeData?.data?.seller_reserve_stat?.seller_reserve_level || 'N/A';

        // Log data ra console
        console.log('[TikTok] ========== RESULT ==========');
        console.log(`Seller ID: ${result.sellerId}`);
        console.log(`OEC Seller ID: ${result.oecSellerId}`);
        console.log('');
        console.log('💰 ON HOLD AMOUNT: ' + toSettleFormatted + ' (' + toSettleAmount + ' USD)');
        console.log('📅 Settlement Period: ' + settlementDays + ' days');
        console.log('🔒 Reserve Level: Level ' + reserveLevel);
        console.log('');
        console.log('[TikTok] ================================');

        // Đóng tab (giữ browser mở)
        await page.close();

        // Disconnect khỏi browser (không đóng browser)
        await browser.disconnect();

        console.log('[TikTok] Data fetch completed successfully');
        return result;

    } catch (error: any) {
        console.error('[TikTok] Error fetching data:', error.message);
        throw error;
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 750,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
        title: 'Hidemyacc Profile Manager',
        minWidth: 800,
        minHeight: 600,
    });

    mainWindow.loadFile(path.join(__dirname, '../../src/index.html'));

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});

// Helper
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// API: Lấy danh sách profiles
ipcMain.handle('get-profiles', async () => {
    try {
        const response = await axios.get<ApiResponse<Profile[]>>(`${API_BASE}/profiles`);
        return { success: true, data: response.data.data };
    } catch (error: any) {
        return {
            success: false,
            message: error.code === 'ECONNREFUSED'
                ? 'Không thể kết nối Hidemyacc. Hãy mở app Hidemyacc trước!'
                : error.message
        };
    }
});

// ============================================
// API: Credentials Management
// ============================================
ipcMain.handle('upload-credentials-excel', async (_event, fileBuffer: Uint8Array) => {
    try {
        console.log(`[IPC] Uploading credentials from Excel Buffer (size: ${fileBuffer.length})`);
        // Convert Uint8Array to Node Buffer
        const buffer = Buffer.from(fileBuffer);
        const result = loadCredentialsFromExcelBuffer(buffer);
        return result;
    } catch (error: any) {
        console.error('[IPC] Excel Upload Error:', error.message);
        return { success: false, message: error.message };
    }
});

// ============================================
// API: Auto-login TikTok Seller Center
// ============================================
ipcMain.handle('login-tiktok', async (_event, profileId: string, profileName?: string) => {
    try {
        console.log(`[Login] Starting login for profile ${profileId}...`);

        // Step 0: Get credentials - Try by NAME first (exact match), then by ID
        let credentials = null;

        // 1. Try by name first (if provided)
        if (profileName) {
            credentials = getCredentialsByProfileName(profileName);
        }

        // 2. Fallback to ID
        if (!credentials) {
            credentials = getCredentialsByProfileId(profileId);
        }

        if (!credentials) {
            return {
                success: false,
                message: `Missing credentials for profile ${profileName || profileId}. Please upload the Excel file containing this profile!`
            };
        }

        console.log(`[Login] Found credentials for: ${credentials.profileName}`);

        // Step 1: Start profile
        let port: number;
        try {
            const startResponse = await axios.post<ApiResponse<StartProfileData>>(`${API_BASE}/profiles/start/${profileId}`);
            if (startResponse.data.code !== 1 || !startResponse.data.data.success) {
                throw new Error('Failed to start profile');
            }
            port = startResponse.data.data.port;
            console.log(`[Login] Profile started on port ${port}`);
        } catch (startError: any) {
            const statusCode = startError.response?.status;

            if (statusCode === 409) {
                // Profile already running - get port
                console.log(`[Login] Profile already running, getting port...`);
                try {
                    const statusResponse = await axios.get(`${API_BASE}/profiles/status/${profileId}`);
                    if (statusResponse.data?.data?.port) {
                        port = statusResponse.data.data.port;
                    } else {
                        throw new Error('Could not get port from running profile');
                    }
                } catch (e) {
                    throw new Error('Profile conflict - could not get port');
                }
            } else if (statusCode === 400) {
                return { success: false, message: 'Profile is in use by another user' };
            } else {
                throw startError;
            }
        }

        // Step 2: Wait for browser to initialize
        await sleep(3000);

        // Step 3: Calculate window position for grid layout
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

        // Get unique window position (thread-safe)
        const windowIndex = getNextWindowPosition();
        console.log(`[Login] Assigned window position: ${windowIndex}`);

        try {
            // Step 4: Perform login with credentials and window layout info
            const result = await loginTikTokSeller(port!, {
                email: credentials.email,
                password: credentials.password,
                twoFactorSecret: credentials.twoFactorSecret
            }, {
                screenWidth,
                screenHeight,
                windowIndex,
                maxWindows: MAX_WINDOWS
            });

            return result;
        } finally {
            // Release position after login (success or fail)
            releaseWindowPosition(windowIndex);
        }

    } catch (error: any) {
        console.error('[Login] Error:', error.message);
        return { success: false, message: error.message };
    }
});

// API: Chạy 1 profile
ipcMain.handle('start-profile', async (_event, profileId: string) => {
    try {
        const response = await axios.post<ApiResponse<StartProfileData>>(`${API_BASE}/profiles/start/${profileId}`);
        if (response.data.code === 1 && response.data.data.success) {
            return {
                success: true,
                data: response.data.data,
                message: `Đã khởi động! Port: ${response.data.data.port}`
            };
        }
        return { success: false, message: 'Không thể khởi động profile' };
    } catch (error: any) {
        return {
            success: false,
            message: error.response?.data?.message || error.message
        };
    }
});

// API: Dừng 1 profile
ipcMain.handle('stop-profile', async (_event, profileId: string) => {
    try {
        await axios.post(`${API_BASE}/profiles/stop/${profileId}`);
        return { success: true, message: 'Đã dừng profile' };
    } catch (error: any) {
        return { success: false, message: error.message };
    }
});

// API: Chạy tuần tự nhiều profiles
ipcMain.handle('run-all-profiles', async (_event, profileIds: string[], delayMs: number) => {
    const results: { id: string; success: boolean; message: string; port?: number }[] = [];

    for (let i = 0; i < profileIds.length; i++) {
        const profileId = profileIds[i];

        // Gửi progress update
        mainWindow?.webContents.send('run-progress', {
            current: i + 1,
            total: profileIds.length,
            profileId,
            status: 'running'
        });

        try {
            const response = await axios.post<ApiResponse<StartProfileData>>(`${API_BASE}/profiles/start/${profileId}`);
            if (response.data.code === 1 && response.data.data.success) {
                results.push({
                    id: profileId,
                    success: true,
                    message: 'Thành công',
                    port: response.data.data.port
                });
            } else {
                results.push({
                    id: profileId,
                    success: false,
                    message: 'Không thể khởi động'
                });
            }
        } catch (error: any) {
            results.push({
                id: profileId,
                success: false,
                message: error.response?.data?.message || error.message
            });
        }

        // Gửi update sau khi hoàn thành
        mainWindow?.webContents.send('run-progress', {
            current: i + 1,
            total: profileIds.length,
            profileId,
            status: results[results.length - 1].success ? 'success' : 'error'
        });

        // Delay giữa các profiles (trừ profile cuối)
        if (i < profileIds.length - 1) {
            await sleep(delayMs);
        }
    }

    return { success: true, results };
});

// ============================================
// API: Lấy dữ liệu TikTok Finance
// ============================================
ipcMain.handle('fetch-tiktok-data', async (_event, debugPort: number) => {
    try {
        console.log(`[IPC] Fetching TikTok data from port ${debugPort}...`);

        // Wait 2 seconds để browser load xong
        await sleep(2000);

        const data = await fetchTikTokFinanceData(debugPort);

        return {
            success: true,
            data,
            message: 'Đã lấy dữ liệu TikTok thành công!'
        };
    } catch (error: any) {
        return {
            success: false,
            message: error.message
        };
    }
});

// API: Chạy profile VÀ lấy TikTok data (tự động)
ipcMain.handle('run-and-fetch-tiktok', async (_event, profileId: string) => {
    try {
        console.log(`[Auto] Starting profile ${profileId} and fetching TikTok data...`);

        // Bước 1: Khởi động profile (xử lý 409/400)
        let port: number;

        try {
            const startResponse = await axios.post<ApiResponse<StartProfileData>>(`${API_BASE}/profiles/start/${profileId}`);
            if (startResponse.data.code !== 1 || !startResponse.data.data.success) {
                throw new Error('Start failed');
            }
            port = startResponse.data.data.port;
        } catch (startError: any) {
            const statusCode = startError.response?.status;

            // 409: Profile đang chạy -> lấy port cũ
            if (statusCode === 409) {
                console.log(`[Auto] ⚠ Profile already running, trying to get port...`);
                try {
                    const statusResponse = await axios.get(`${API_BASE}/profiles/status/${profileId}`);
                    if (statusResponse.data?.data?.port) {
                        port = statusResponse.data.data.port;
                        console.log(`[Auto] ✓ Connect to running profile on port ${port}`);
                    } else {
                        throw new Error('Profile running but no port available');
                    }
                } catch (e) {
                    throw new Error('Profile conflict (409) - could not get port');
                }
            }
            // 400: Profile đang in-use -> Báo lỗi thân thiện
            else if (statusCode === 400) {
                return { success: false, message: 'Profile is in use by another user' };
            }
            else {
                throw startError;
            }
        }

        console.log(`[Auto] Profile running on port ${port}`);

        // Bước 2: Đợi browser load (giảm xuống 3s)
        console.log('[Auto] Waiting for browser to initialize...');
        await sleep(3000);

        // Bước 3: Lấy TikTok data bằng FAST approach
        console.log('[Auto] Fetching TikTok Finance data (Fast Mode)...');
        const tiktokData = await fetchTikTokDataFast(port!, profileId);

        return {
            success: true,
            port,
            tiktokData,
            message: `Hoàn tất! On Hold: ${tiktokData.summary?.onHoldAmount}, Paid: ${tiktokData.summary?.sumAmount}`
        };

    } catch (error: any) {
        console.error('[Auto] Error:', error.message);
        return {
            success: false,
            message: error.message
        };
    }
});

// ============================================
// API: Batch Fetch TikTok data từ nhiều profiles
// ============================================
ipcMain.handle('batch-fetch-tiktok', async (_event, profileIds: string[], delayMs: number) => {
    const results: {
        profileId: string;
        profileName?: string;
        success: boolean;
        sellerId?: string;
        onHoldAmount?: string;
        sumAmount?: string;
        monthlyData?: { date_time_lower: number; date_time_upper: number; settlement: string }[];
        message: string;
    }[] = [];

    console.log(`[Batch] Starting batch fetch for ${profileIds.length} profiles...`);

    // ===============================================
    // CẤU HÌNH CONCURRENCY (SỐ LUỒNG CHẠY SONG SONG)
    // ===============================================
    const CHUNK_SIZE = 3; // Giảm xuống 3 để ổn định hơn
    const MAX_RETRIES = 1; // Retry 1 lần nếu fail

    console.log(`[Batch] Starting batch fetch for ${profileIds.length} profiles (Parallel: ${CHUNK_SIZE}, Retries: ${MAX_RETRIES})...`);

    // Helper function để xử lý 1 profile đơn lẻ (có retry)
    const processProfile = async (profileId: string, index: number, retryCount = 0): Promise<typeof results[0]> => {
        try {
            console.log(`\n[Batch] ▶ Start Profile ${index + 1}: ${profileId}${retryCount > 0 ? ` (Retry ${retryCount})` : ''}`);

            let port: number;

            // 1. Khởi động profile (với xử lý 409/400)
            try {
                const startResponse = await axios.post<ApiResponse<StartProfileData>>(`${API_BASE}/profiles/start/${profileId}`);
                if (startResponse.data.code !== 1 || !startResponse.data.data.success) {
                    throw new Error('Start failed');
                }
                port = startResponse.data.data.port;
            } catch (startError: any) {
                const statusCode = startError.response?.status;

                // 409: Profile đang chạy - thử lấy port từ status
                if (statusCode === 409) {
                    console.log(`[Batch] ⚠ Profile already running, trying to get port...`);
                    try {
                        const statusResponse = await axios.get(`${API_BASE}/profiles/status/${profileId}`);
                        if (statusResponse.data?.data?.port) {
                            port = statusResponse.data.data.port;
                            console.log(`[Batch] ✓ Got port ${port} from running profile`);
                        } else {
                            throw new Error('Profile running but no port available');
                        }
                    } catch (e) {
                        throw new Error('Profile conflict (409) - could not get port');
                    }
                }
                // 400: Profile đang được sử dụng bởi user khác - SKIP (không retry)
                else if (statusCode === 400) {
                    return { profileId, success: false, message: '⚠ Skipped - Profile in use by another user' };
                }
                else {
                    throw startError;
                }
            }

            // 2. Đợi browser và Lấy data
            await sleep(3000);
            const tiktokData = await fetchTikTokDataFast(port!, profileId);

            // 3. Kết quả - Dùng summary từ function
            const onHoldAmount = tiktokData.summary?.onHoldAmount || 'N/A';
            const sumAmount = tiktokData.summary?.sumAmount || 'N/A';
            const monthlyData = tiktokData.summary?.monthly || [];

            return {
                profileId,
                success: true,
                sellerId: tiktokData.sellerId,
                onHoldAmount,
                sumAmount,
                monthlyData,
                message: `Data retrieval successful`
            };

        } catch (error: any) {
            console.error(`[Batch] ✗ Error ${profileId}:`, error.message);
            // Cố gắng stop profile nếu lỗi giữa chừng
            try { await axios.post(`${API_BASE}/profiles/stop/${profileId}`); } catch (e) { }

            // Không retry nếu là lỗi "in use"
            if (error.message.includes('Skipped') || error.message.includes('in use')) {
                return { profileId, success: false, message: error.message };
            }

            // RETRY LOGIC
            if (retryCount < MAX_RETRIES) {
                console.log(`[Batch] Retrying ${profileId} in 5s...`);
                await sleep(5000);
                return processProfile(profileId, index, retryCount + 1);
            }

            return { profileId, success: false, message: error.message };
        }
    };

    // CHẠY THEO TỪNG NHÓM (CHUNK) VỚI STAGGERED START
    for (let i = 0; i < profileIds.length; i += CHUNK_SIZE) {
        const chunk = profileIds.slice(i, i + CHUNK_SIZE);
        console.log(`\n[Batch] === Processing Chunk ${Math.floor(i / CHUNK_SIZE) + 1} (Profiles ${i + 1}-${Math.min(i + CHUNK_SIZE, profileIds.length)}) ===`);

        // Gửi status update
        mainWindow?.webContents.send('fetch-progress', {
            current: i,
            total: profileIds.length,
            profileId: `Chunk ${Math.floor(i / CHUNK_SIZE) + 1} running...`,
            status: 'running'
        });

        // Chạy song song nhưng stagger start (delay 1s giữa mỗi profile)
        const chunkPromises = chunk.map((id, idx) => {
            return new Promise<typeof results[0]>(async (resolve) => {
                await sleep(idx * 1000); // Stagger: profile 0 start ngay, profile 1 đợi 1s, profile 2 đợi 2s...
                const result = await processProfile(id, i + idx);
                resolve(result);
            });
        });
        const chunkResults = await Promise.all(chunkPromises);

        // Lưu kết quả
        results.push(...chunkResults);

        // Log và Gửi update cho từng item xong
        chunkResults.forEach(r => {
            console.log(`[Batch] Finished: ${r.profileId} -> ${r.success ? r.onHoldAmount : r.message}`);
            mainWindow?.webContents.send('fetch-progress', {
                current: results.length,
                total: profileIds.length,
                profileId: r.profileId,
                status: r.success ? 'success' : 'error',
                result: r
            });
        });

        // Delay nhẹ giữa các chunk để CPU thở
        if (i + CHUNK_SIZE < profileIds.length) {
            console.log('[Batch] Cooling down 2s...');
            await sleep(2000);
        }
    }

    // Log tổng kết
    console.log('\n[Batch] ========== BATCH COMPLETE ==========');
    console.log(`Total: ${profileIds.length} profiles`);
    console.log(`Success: ${results.filter(r => r.success).length}`);
    console.log(`Failed: ${results.filter(r => !r.success).length}`);
    console.log('');
    results.forEach((r, idx) => {
        const status = r.success ? '✓' : '✗';
        console.log(`  ${idx + 1}. [${status}] ${r.profileId} - ${r.message}`);
    });
    console.log('[Batch] ==========================================\n');

    // Log JSON cho verification
    console.log('[Batch] ========== JSON RESULT ==========');
    console.log(JSON.stringify(results, null, 2));
    console.log('[Batch] ==================================\n');

    return { success: true, results };
});

