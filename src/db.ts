import mysql from 'mysql2/promise';

// Tạo connection pool
const pool = mysql.createPool({
    host: '127.0.0.1',
    port: 3306,
    database: 'balance-feline',
    user: 'root',
    password: '123456',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Helper function to parse money string to number (e.g., "$29,190.15" -> 29190.15)
function parseMoney(val: string | undefined): number {
    if (!val) return 0;
    return parseFloat(val.replace(/[\$,]/g, '')) || 0;
}

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
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const bankLast4 = data.bankAccountNumber ? data.bankAccountNumber.slice(-4) : null;

        // Cố gắng tách profile_code (ví dụ từ "1373 Monica..." ra "1373")
        let profileCode = data.profileId;
        if (data.profileName) {
            const parts = data.profileName.split(' ');
            if (parts.length > 0 && !isNaN(Number(parts[0]))) {
                profileCode = parts[0];
            }
        }

        // 1. Upsert Profile TRƯỚC (để FK constraint không bị lỗi)
        await connection.execute(
            `INSERT INTO profiles (id, profile_name, profile_code, seller_id, bank_last4, beneficiary_name, status)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                 profile_name = VALUES(profile_name),
                 profile_code = VALUES(profile_code),
                 seller_id = COALESCE(VALUES(seller_id), seller_id),
                 bank_last4 = COALESCE(VALUES(bank_last4), bank_last4),
                 beneficiary_name = COALESCE(VALUES(beneficiary_name), beneficiary_name),
                 status = VALUES(status)`,
            [
                data.profileId,
                data.profileName || '',
                profileCode,
                data.sellerId || null,
                bankLast4,
                data.beneficiaryName || null,
                data.status === 'success' ? 'active' : 'error'
            ]
        );

        // 2. Log Fetch execution (sau khi profile đã tồn tại)
        if (data.status) {
            await connection.execute(
                `INSERT INTO fetch_logs (profile_id, status, error_message, duration_ms)
                 VALUES (?, ?, ?, ?)`,
                [data.profileId, data.status, data.errorMessage || null, data.durationMs || 0]
            );
        }

        // Nếu failed thì không có data balance/monthly để update
        if (data.status !== 'success' && !data.sellerId && !data.onHoldAmount) {
            await connection.commit();
            return;
        }

        // 3. Upsert Balance
        const netEarning = parseMoney(data.netEarning);
        const onHoldAmount = parseMoney(data.onHoldAmount);
        const totalPaid = parseMoney(data.sumAmount);

        await connection.execute(
            `INSERT INTO balances (profile_id, net_earning, on_hold_amount, total_paid)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                 net_earning = VALUES(net_earning),
                 on_hold_amount = VALUES(on_hold_amount),
                 total_paid = VALUES(total_paid)`,
            [data.profileId, netEarning, onHoldAmount, totalPaid]
        );

        // 4. Upsert Monthly Settlements
        if (data.monthlyData && data.monthlyData.length > 0) {
            for (const monthItem of data.monthlyData) {
                // month in data is like "01/2026", convert to "2026-01"
                const parts = monthItem.month.split('/');
                if (parts.length === 2) {
                    const monthFormatted = `${parts[1]}-${parts[0]}`;
                    const settlementAmount = parseMoney(monthItem.settlement);

                    await connection.execute(
                        `INSERT INTO monthly_settlements (profile_id, month, settlement)
                         VALUES (?, ?, ?)
                         ON DUPLICATE KEY UPDATE
                             settlement = VALUES(settlement)`,
                        [data.profileId, monthFormatted, settlementAmount]
                    );
                }
            }
        }

        await connection.commit();
        console.log(`[DB] ✓ Saved data for profile: ${data.profileId}`);
    } catch (error) {
        await connection.rollback();
        console.error(`[DB] ✗ Transaction failed for ${data.profileId}:`, error);
    } finally {
        connection.release();
    }
}
