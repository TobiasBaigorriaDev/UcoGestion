import type { Pool, PoolClient } from 'pg';

export interface AvailableOrganization {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly role: 'ADMIN' | 'CASHIER' | 'EMPLOYEE' | 'OWNER';
}

interface AvailableOrganizationRow {
  organizationId: string;
  organizationName: string;
  role: AvailableOrganization['role'];
}

export class OrganizationNotAvailableError extends Error {
  readonly code = 'ORGANIZATION_NOT_AVAILABLE';

  constructor() {
    super('La organización no está disponible para tu sesión.');
    this.name = 'OrganizationNotAvailableError';
  }
}

export class GlobalMembershipDiscoveryService {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}

  async list(userId: string): Promise<AvailableOrganization[]> {
    return this.withIdentity(userId, async (client) => {
      const result = await client.query<AvailableOrganizationRow>(
        `SELECT organization_id AS "organizationId", organization_name AS "organizationName", role
         FROM identity_api.list_active_memberships()`,
      );
      return result.rows;
    });
  }

  async select(userId: string, organizationId: string): Promise<AvailableOrganization> {
    const selected = await this.withIdentity(userId, async (client) => {
      const result = await client.query<AvailableOrganizationRow>(
        `SELECT organization_id AS "organizationId", organization_name AS "organizationName", role
         FROM identity_api.select_active_membership($1)`,
        [organizationId],
      );
      return result.rows[0] ?? null;
    });
    if (!selected) throw new OrganizationNotAvailableError();
    return selected;
  }

  private async withIdentity<T>(userId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE uco_app');
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
