/**
 * TikTok Seller Center Auto-Login Module
 * 
 * Features:
 * - Human-like typing simulation
 * - Auto-fill email & password
 * - 2FA support (via 2fa.live API)
 */

import puppeteer from 'puppeteer-core';
import axios from 'axios';

// ============================================
// INTERFACES
// ============================================

export interface LoginCredentials {
    email: string;
    password: string;
    twoFactorSecret?: string; // TOTP secret for 2FA (e.g., DBNNYLCUVABDGASYQJB3ZMOHYKY72KDO)
}

export interface LoginResult {
    success: boolean;
    message: string;
    requires2FA?: boolean;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Human-like typing with random delays between characters
 * Uses keyboard.type() for better React compatibility
 */
async function humanType(page: any, selector: string, text: string): Promise<void> {
    // Click to focus the input
    await page.click(selector);
    await sleep(300);

    // Clear any existing value (triple-click to select all, then delete)
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await sleep(200);

    // Type each character using keyboard (more reliable for React)
    for (const char of text) {
        await page.keyboard.type(char, { delay: 50 + Math.random() * 100 });
        await sleep(20 + Math.random() * 30); // Small random delay between chars
    }
}

/**
 * Get 2FA code from 2fa.live API
 * @param secret - TOTP secret (e.g., DBNNYLCUVABDGASYQJB3ZMOHYKY72KDO)
 * @returns 6-digit code or null if failed
 */
async function get2FACode(secret: string): Promise<string | null> {
    try {
        console.log('[2FA] Fetching code from 2fa.live...');
        const response = await axios.get(`https://2fa.live/tok/${secret}`, { timeout: 10000 });
        console.log('response [2FA] Fetching ', response.data);
        const code = response.data?.token;
        if (code) {
            console.log(`[2FA] ✓ Got code: ${code}`);
            return code;
        }
        return null;
    } catch (error: any) {
        console.error('[2FA] Failed to get code:', error.message);
        return null;
    }
}

// ============================================
// MAIN LOGIN FUNCTION
// ============================================

/**
 * Auto-login to TikTok Seller Center
 * 
 * Flow:
 * 1. Navigate to login page
 * 2. Fill email & password with human-like typing
 * 3. Click login button
 * 4. Handle 2FA if required (optional)
 * 
 * @param debugPort - Browser debug port (from Hidemyacc)
 * @param credentials - Login credentials (email, password, optional 2FA secret)
 */
export async function loginTikTokSeller(
    debugPort: number,
    credentials: LoginCredentials
): Promise<LoginResult> {
    console.log(`[Login] Connecting to browser on port ${debugPort}...`);

    let browser: any = null;
    let page: any = null;

    try {
        // Connect to browser
        browser = await puppeteer.connect({
            browserURL: `http://127.0.0.1:${debugPort}`,
            defaultViewport: null
        });
        console.log('[Login] ✓ Connected to browser');

        // Get existing page or create new one
        const pages = await browser.pages();
        page = pages.length > 0 ? pages[0] : await browser.newPage();

        // Navigate to login page (use domcontentloaded for faster load)
        console.log('[Login] Navigating to TikTok Seller login page...');
        await page.goto('https://seller-us.tiktok.com/account/login', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        // Wait for page to fully render (React needs time)
        console.log('[Login] Waiting for page to render...');
        await sleep(3000);

        // Check if already logged in (redirected to homepage)
        const afterNavigateUrl = page.url();
        console.log(`[Login] Current URL after navigate: ${afterNavigateUrl}`);

        if (afterNavigateUrl.includes('homepage') ||
            afterNavigateUrl.includes('dashboard') ||
            (afterNavigateUrl.includes('seller-us.tiktok.com') && afterNavigateUrl.includes('setup='))) {
            console.log('[Login] ✓ Already logged in!');
            await browser.disconnect();
            return { success: true, message: 'Already logged in!' };
        }

        // Wait for email input to be visible (might not appear if already logged in)
        console.log('[Login] Waiting for login form...');
        try {
            await page.waitForSelector('#email_input', { visible: true, timeout: 10000 });
        } catch (e) {
            // Login form not found - check URL again
            const currentUrl = page.url();
            if (currentUrl.includes('homepage') || currentUrl.includes('dashboard') || currentUrl.includes('setup=')) {
                console.log('[Login] ✓ Already logged in (detected after wait)!');
                await browser.disconnect();
                return { success: true, message: 'Already logged in!' };
            }
            throw new Error('Login form not found and not logged in');
        }

        // Extra wait for React to finish rendering
        await sleep(1000);

        // Clear any existing values using JavaScript (more reliable)
        console.log('[Login] Clearing inputs...');
        await page.evaluate(() => {
            const emailInput = document.querySelector('#email_input') as HTMLInputElement;
            const passwordInput = document.querySelector('#email_password_input') as HTMLInputElement;
            if (emailInput) {
                emailInput.value = '';
                emailInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (passwordInput) {
                passwordInput.value = '';
                passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });

        // Type email with human-like speed
        console.log('[Login] Typing email...');
        await humanType(page, '#email_input', credentials.email);

        // Small delay between fields (human behavior)
        await sleep(500 + Math.random() * 500);

        // Type password with human-like speed
        console.log('[Login] Typing password...');
        await humanType(page, '#email_password_input', credentials.password);

        // Small delay before clicking login
        await sleep(500 + Math.random() * 500);

        // Find and click login button (Continue/Log in)
        // IMPORTANT: Must use [type="submit"] to avoid clicking "Join now" button
        console.log('[Login] Clicking login button...');
        const loginButtonSelectors = [
            'button[data-tid="m4b_button"][type="submit"]',  // Most specific - only the submit button
            'button[data-uid^="loginform:redbutton"]',       // Backup - data-uid starts with loginform
            'button.RedButton-Hx7b_O[type="submit"]',        // Class + type
            'form button[type="submit"]'                      // Any submit button in form
        ];

        let clicked = false;
        for (const selector of loginButtonSelectors) {
            try {
                const button = await page.$(selector);
                if (button) {
                    await button.click();
                    clicked = true;
                    console.log(`[Login] ✓ Clicked button: ${selector}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        if (!clicked) {
            // Try pressing Enter as fallback
            await page.keyboard.press('Enter');
            console.log('[Login] ✓ Pressed Enter to submit');
        }

        // Wait for response after clicking login
        console.log('[Login] Waiting for 2FA form or redirect...');

        // Try to wait for 2FA input to appear (with timeout)
        const twoFAInputSelector = '#two_step_verification_totp_code_input';
        let twoFAInput = null;

        try {
            // Wait up to 10 seconds for 2FA input to appear
            console.log('[Login] Waiting for 2FA input to appear (max 10s)...');
            twoFAInput = await page.waitForSelector(twoFAInputSelector, {
                visible: true,
                timeout: 10000
            });
            console.log('[Login] ✓ 2FA input found!');
        } catch (e) {
            // 2FA input didn't appear - might be successful login or error
            console.log('[Login] 2FA input not found within timeout');
        }

        if (twoFAInput) {
            console.log('[Login] 2FA form detected!');

            // If we have 2FA secret, auto-fill the code
            console.log(`[Login] 2FA secret provided: ${!!credentials.twoFactorSecret}`);
            if (credentials.twoFactorSecret) {
                console.log(`[Login] Fetching 2FA code for secret: ${credentials.twoFactorSecret.substring(0, 8)}...`);
                const code = await get2FACode(credentials.twoFactorSecret);
                console.log(`[Login] 2FA code received: ${code}`);

                if (code) {
                    console.log(`[Login] Entering 2FA code: ${code}`);

                    try {
                        // Wait a bit for input to be ready
                        await sleep(500);

                        // Focus and clear input first
                        await page.click(twoFAInputSelector);
                        await sleep(300);

                        // Type the code directly using keyboard
                        for (const char of code) {
                            await page.keyboard.type(char, { delay: 100 });
                        }
                        console.log('[Login] ✓ Entered 2FA code');

                        // Submit 2FA - click the Continue button
                        await sleep(500);
                        const submitBtn = await page.$('button[data-tid="m4b_button"][type="submit"]');
                        console.log(`[Login] Submit button found: ${submitBtn !== null}`);

                        if (submitBtn) {
                            await submitBtn.click();
                            console.log('[Login] ✓ Clicked 2FA Continue button');
                        } else {
                            await page.keyboard.press('Enter');
                            console.log('[Login] ✓ Pressed Enter to submit 2FA');
                        }

                        // Wait for redirect to dashboard (max 15s)
                        console.log('[Login] Waiting for redirect to dashboard...');
                        try {
                            await page.waitForFunction(
                                () => window.location.href.includes('homepage') || window.location.href.includes('dashboard'),
                                { timeout: 15000 }
                            );

                            const finalUrl = page.url();
                            console.log(`[Login] ✓ Redirected to: ${finalUrl}`);
                            await browser.disconnect();
                            return { success: true, message: 'Login successful with 2FA!' };
                        } catch (e) {
                            console.log('[Login] Redirect timeout - checking current state...');
                        }

                        // Check final state if timeout occurred
                        const newUrl = page.url();
                        console.log(`[Login] URL after usage: ${newUrl}`);

                        if (newUrl.includes('homepage') || newUrl.includes('dashboard')) {
                            await browser.disconnect();
                            return { success: true, message: 'Login successful with 2FA!' };
                        }

                        // Check if still on login page with error
                        await browser.disconnect();
                        return { success: true, message: '2FA submitted - verifying in browser...', requires2FA: true };
                    } catch (error: any) {
                        console.error('[Login] Error entering 2FA code:', error.message);
                        await browser.disconnect();
                        return { success: false, message: `2FA error: ${error.message}` };
                    }
                } else {
                    console.log('[Login] Failed to get 2FA code from API');
                }
            } else {
                console.log('[Login] No 2FA secret in credentials');
            }

            // No 2FA secret provided or code fetch failed
            await browser.disconnect();
            return { success: true, message: '2FA required - please enter code manually', requires2FA: true };
        }

        // No 2FA - check if login successful
        const currentUrl = page.url();
        console.log(`[Login] Current URL: ${currentUrl}`);

        if (currentUrl.includes('homepage') || currentUrl.includes('dashboard') || currentUrl.includes('seller-us.tiktok.com/homepage')) {
            console.log('[Login] ✓ Login successful!');
            await browser.disconnect();
            return { success: true, message: 'Login successful!' };
        }

        // Still on login page - check for error messages
        if (currentUrl.includes('login')) {
            const errorMsg = await page.evaluate(() => {
                const errorEl = document.querySelector('.theme-arco-message-error, .error-message, [class*="error"]');
                return errorEl ? errorEl.textContent : null;
            });

            await browser.disconnect();

            if (errorMsg) {
                return { success: false, message: `Login failed: ${errorMsg}` };
            }
            return { success: false, message: 'Login failed - still on login page' };
        }

        // Unknown state
        await browser.disconnect();
        return { success: true, message: 'Login submitted - check browser for result' };

    } catch (error: any) {
        console.error('[Login] Error:', error.message);
        if (browser) try { await browser.disconnect(); } catch (e) { }
        return { success: false, message: error.message };
    }
}

// ============================================
// BATCH LOGIN (for multiple profiles)
// ============================================

export interface BatchLoginResult {
    profileId: string;
    success: boolean;
    message: string;
}

/**
 * Login to multiple profiles sequentially
 */
export async function batchLoginTikTok(
    profiles: { id: string; port: number; credentials: LoginCredentials }[]
): Promise<BatchLoginResult[]> {
    const results: BatchLoginResult[] = [];

    for (const profile of profiles) {
        console.log(`\n[Batch Login] Processing profile: ${profile.id}`);

        const result = await loginTikTokSeller(profile.port, profile.credentials);
        results.push({
            profileId: profile.id,
            success: result.success,
            message: result.message
        });

        // Small delay between profiles
        await sleep(2000);
    }

    return results;
}
