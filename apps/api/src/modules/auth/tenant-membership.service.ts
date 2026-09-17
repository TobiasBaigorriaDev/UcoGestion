import type { Pool } from 'pg';

export class TenantMembershipService {
  constructor(private readonly pool: Pool) {}

  async isActive(organizationId: string, userId: string, requestId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      await client.query("SELECT set_config('app.request_id', $1, true)", [requestId]);
      const result = await client.query<{ active: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM memberships
           WHERE organization_id = $1 AND user_id = $2 AND revoked_at IS NULL
         ) AS active`,
        [organizationId, userId],
      );
      await client.query('COMMIT');
      return result.rows[0]?.active === true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
