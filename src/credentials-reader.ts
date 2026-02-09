/**
 * Credentials Reader Module
 * 
 * Reads login credentials from Excel (RAM session only)
 * JSON file support has been removed as per request.
 */

import * as XLSX from 'xlsx';

// ============================================
// INTERFACES
// ============================================

export interface ProfileCredentials {
    profileId: string;
    profileName: string;
    email: string;
    password: string;
    twoFactorSecret?: string;
}

export interface CredentialsData {
    profiles: ProfileCredentials[];
}

// ============================================
// SESSION STORAGE (RAM)
// ============================================

// Default empty session
let sessionCredentials: ProfileCredentials[] = [];

// ============================================
// EXCEL FUNCTIONS
// ============================================

export function loadCredentialsFromExcel(filePath: string): { success: boolean, count: number, message: string } {
    try {
        console.log(`[Credentials] Loading Excel from: ${filePath}`);
        const workbook = XLSX.readFile(filePath);
        return parseExcelWorkbook(workbook);
    } catch (error: any) {
        console.error('[Credentials] Excel Error:', error.message);
        return { success: false, count: 0, message: `Excel Error: ${error.message}` };
    }
}

export function loadCredentialsFromExcelBuffer(buffer: Buffer): { success: boolean, count: number, message: string } {
    try {
        console.log(`[Credentials] Loading Excel from Buffer (size: ${buffer.length})`);
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        return parseExcelWorkbook(workbook);
    } catch (error: any) {
        console.error('[Credentials] Excel Buffer Error:', error.message);
        return { success: false, count: 0, message: `Excel Buffer Error: ${error.message}` };
    }
}

function parseExcelWorkbook(workbook: XLSX.WorkBook): { success: boolean, count: number, message: string } {
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // Convert to JSON
    const rawData = XLSX.utils.sheet_to_json(sheet) as any[];

    if (!rawData || rawData.length === 0) {
        return { success: false, count: 0, message: 'Excel file is empty' };
    }

    const profiles: ProfileCredentials[] = [];

    for (const row of rawData) {
        // Map columns (flexible keys)
        // Expected: profileId | profileName | email | password | twoFactorSecret
        const normalizedRow: any = {};
        for (const key of Object.keys(row)) {
            // Normalize key: remove spaces, lowercase
            const cleanKey = key.trim().toLowerCase().replace(/\s+/g, '');
            normalizedRow[cleanKey] = row[key];
        }

        // Check keys (handle variations)
        const pId = normalizedRow['profileid'] || normalizedRow['id'];
        const pName = normalizedRow['profilename'] || normalizedRow['name'];
        const email = normalizedRow['email'] || normalizedRow['username'] || normalizedRow['user'];
        const pass = normalizedRow['password'] || normalizedRow['pass'];

        if (pId && email && pass) {
            profiles.push({
                profileId: String(pId).trim(),
                profileName: String(pName || '').trim(),
                email: String(email).trim(),
                password: String(pass).trim(),
                twoFactorSecret: normalizedRow['twofactorsecret'] ? String(normalizedRow['twofactorsecret']).trim() : undefined
            });
        }
    }

    if (profiles.length > 0) {
        sessionCredentials = profiles;
        console.log(`[Credentials] Loaded ${profiles.length} profiles from Excel (Session Mode)`);

        // Debug Log
        if (profiles.length > 0) {
            console.log(`[Credentials] First loaded profile ID: ${profiles[0].profileId}`);
        }

        return { success: true, count: profiles.length, message: `Loaded ${profiles.length} profiles from Excel` };
    } else {
        return { success: false, count: 0, message: 'No valid profiles found (Check headers: profileId, email, password)' };
    }
}

// ============================================
// READ FUNCTIONS
// ============================================

/**
 * Read all credentials (RAM only)
 */
export function readAllCredentials(): CredentialsData {
    return { profiles: sessionCredentials };
}

/**
 * Get credentials for a specific profile by ID
 */
export function getCredentialsByProfileId(profileId: string): ProfileCredentials | null {
    const normalizedId = profileId.trim();
    const profile = sessionCredentials.find(p => p.profileId === normalizedId);

    if (profile) {
        console.log(`[Credentials] Found credentials for profile: ${profile.profileName} (Source: RAM)`);
        return profile;
    }

    console.log(`[Credentials] No credentials found in RAM for profile: '${normalizedId}'. Total loaded: ${sessionCredentials.length}`);
    return null;
}

/**
 * Get credentials for a specific profile by name (EXACT match, case-insensitive)
 */
export function getCredentialsByProfileName(profileName: string): ProfileCredentials | null {
    if (!profileName) return null;

    const searchName = profileName.toLowerCase().trim();
    const profile = sessionCredentials.find(p =>
        p.profileName.toLowerCase().trim() === searchName
    );

    if (profile) {
        console.log(`[Credentials] Found credentials by NAME: ${profile.profileName}`);
        return profile;
    }

    console.log(`[Credentials] No exact name match for: '${profileName}'`);
    return null;
}

// Stub functions to prevent Errors in main.ts if used, but they do nothing or throw warning logic
export function saveCredentials(credentials: ProfileCredentials): boolean {
    console.warn('[Credentials] Save not supported in RAM-only mode');
    return false;
}

export function deleteCredentials(profileId: string): boolean {
    console.warn('[Credentials] Delete not supported in RAM-only mode');
    return false;
}
