import { z } from 'zod';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { CashSessionDeviceError } from './cash-session-device.policy.js';
import { encodeCursor,parseCursorPageQuery } from '../../core/validation/pagination.js';

export const cashWorkspaceQuerySchema=z.strictObject({branchId:z.uuid(),view:z.enum(['ACTIVE','FINAL','PENDING_REVIEW']).default('ACTIVE'),
  limit:z.coerce.number().int().min(1).max(100).default(25),cursor:z.string().max(512).optional(),sessionId:z.uuid().optional()});
interface CashWorkspaceSessionRow {
  id:string;cashRegisterId:string;registerName:string;deviceId:string;status:string;openingCash:string;expectedCash:string;
  currencyCode:string;openedAt:Date;cursorTime:string;closeAttemptId:string|null;lastAbortedAttemptId:string|null;
  chain:{sequence:string;headHash:string;sessionSequence:string};finalSync:{ready:true;expectedCash:string}|null;
  closure:{expectedCash:string;countedCash:string;difference:string;reason:string|null}|null;
  differenceReview:{id:string;status:'PENDING_REVIEW'|'REVIEWED';selfReview:boolean;canReview:boolean}|null;
  deviceStatus:string;completeness:string;currencyPermanentlyLocked:boolean;
  exceptionalClosure:{expectedCashKnown:string;countedCash:string|null;differenceObserved:string|null;lastContactAt:string|null;reason:string;
    operationsReceived:readonly {operationId:string;sequence:string;occurredAt:string;receivedAt:string}[]}|null;
  lateData:{marker:'LATE_RECOVERED_OPERATIONS';throughOperationId:string;sequence:string;receivedAt:string;count:string;status:'PENDING_REVIEW'|'REVIEWED'}|null;
}

/** Public projection; raw device credentials and persistence entities never leave this module. */
export class CashWorkspaceService {
  constructor(private readonly transactions:TenantTransaction) {}

  async checkpoint(context:TenantTransactionContext,sessionId:string) {
    z.uuid().parse(sessionId);
    return this.transactions.read(context,async client=>{
      const result=await client.query<{sequence:string;headHash:string;sessionSequence:string}>(`SELECT
        COALESCE((SELECT s.sequence::text FROM sync_operations s WHERE s.organization_id=cs.organization_id AND s.device_id=cs.device_id
          ORDER BY s.sequence DESC LIMIT 1),'0') AS sequence,
        COALESCE((SELECT s.operation_hash FROM sync_operations s WHERE s.organization_id=cs.organization_id AND s.device_id=cs.device_id
          ORDER BY s.sequence DESC LIMIT 1),repeat('0',64)) AS "headHash",
        (SELECT count(*)::text FROM sync_operations s WHERE s.organization_id=cs.organization_id AND s.device_id=cs.device_id
          AND s.session_id=cs.id) AS "sessionSequence"
        FROM cash_sessions cs JOIN memberships m ON m.organization_id=cs.organization_id AND m.user_id=$2
        JOIN branches b ON b.organization_id=cs.organization_id AND b.id=cs.branch_id AND b.status='ACTIVE'
        WHERE cs.organization_id=$1 AND cs.id=$3 AND m.status='ACTIVE' AND m.revoked_at IS NULL
          AND m.role IN ('OWNER','ADMIN','CASHIER') AND (m.role<>'CASHIER' OR cs.owner_user_id=$2)
          AND (m.role='OWNER' OR EXISTS(SELECT 1 FROM effective_membership_branch_scope bs WHERE bs.organization_id=m.organization_id
            AND bs.membership_id=m.id AND bs.branch_id=cs.branch_id))`,[context.organizationId,context.userId,sessionId]);
      if(!result.rows[0])throw new CashSessionDeviceError('CASH_SESSION_ACTOR_FORBIDDEN','No podés acceder al checkpoint de esta sesión.');
      return result.rows[0];
    });
  }

  async read(context:TenantTransactionContext,branchId:string,options:{view?:'ACTIVE'|'FINAL'|'PENDING_REVIEW';limit?:number;cursor?:string;sessionId?:string}={}) {
    z.uuid().parse(branchId);
    const input=cashWorkspaceQuerySchema.parse({branchId,...options});
    let pagination:ReturnType<typeof parseCursorPageQuery>;
    try {
      pagination=parseCursorPageQuery({limit:input.limit,...(input.cursor ? {cursor:input.cursor}:{})},[]);
      if(pagination.cursor) z.iso.datetime({offset:true}).parse(new Date(pagination.cursor.sortValue).toISOString());
    }catch{throw new RangeError('Los parámetros del listado de caja son inválidos.');}
    return this.transactions.read(context,async client=>{
      const actor=(await client.query<{id:string;role:string}>(`SELECT id,role FROM memberships
        WHERE organization_id=$1 AND user_id=$2 AND status='ACTIVE' AND revoked_at IS NULL`,
      [context.organizationId,context.userId])).rows[0];
      const branch=await client.query(`SELECT 1 FROM branches WHERE organization_id=$1 AND id=$2
        AND status='ACTIVE'`,[context.organizationId,branchId]);
      const scope=actor?.role==='OWNER' || !!(actor && (await client.query(`SELECT 1 FROM effective_membership_branch_scope
        WHERE organization_id=$1 AND membership_id=$2 AND branch_id=$3`,[context.organizationId,actor.id,branchId])).rowCount);
      if (!actor || !['OWNER','ADMIN','CASHIER'].includes(actor.role) || !branch.rowCount || !scope) {
        throw new CashSessionDeviceError('CASH_SESSION_ACTOR_FORBIDDEN','No tenés permiso para operar cajas de esta sucursal.');
      }
      const registers=await client.query<{id:string;name:string;available:boolean}>(`SELECT cr.id,cr.name,
        NOT EXISTS(SELECT 1 FROM cash_sessions cs WHERE cs.organization_id=cr.organization_id AND cs.cash_register_id=cr.id
          AND cs.status IN ('OPEN','CLOSING','CONFLICTED')) AS available
        FROM cash_registers cr WHERE cr.organization_id=$1 AND cr.branch_id=$2 AND cr.status='ACTIVE' ORDER BY cr.name,cr.id`,
      [context.organizationId,branchId]);
      const devices=await client.query<{id:string;status:string;publicKey:string|null}>(`SELECT id,status,public_key AS "publicKey"
        FROM devices WHERE organization_id=$1 AND branch_id=$2 AND status='ACTIVE' ORDER BY id`,[context.organizationId,branchId]);
      const sessions=await client.query<CashWorkspaceSessionRow>(`SELECT cs.id,cs.cash_register_id AS "cashRegisterId",
        cr.name AS "registerName",cs.device_id AS "deviceId",cs.status,cs.opening_cash AS "openingCash",
        cs.expected_cash AS "expectedCash",cs.currency_code AS "currencyCode",cs.opened_at AS "openedAt",cs.opened_at::text AS "cursorTime",
        d.status AS "deviceStatus",cs.completeness,o.currency_permanently_locked_at IS NOT NULL AS "currencyPermanentlyLocked",
        CASE WHEN x.id IS NULL THEN NULL ELSE jsonb_build_object('expectedCashKnown',x.snapshot->>'expectedCashKnown',
          'countedCash',x.snapshot->>'countedCash','differenceObserved',x.snapshot->>'differenceObserved',
          'lastContactAt',x.snapshot->>'lastContactAt','reason',x.snapshot->>'reason','operationsReceived',x.snapshot->'operationsReceived') END AS "exceptionalClosure",
        CASE WHEN late.operation_id IS NULL THEN NULL ELSE jsonb_build_object('marker','LATE_RECOVERED_OPERATIONS',
          'throughOperationId',late.operation_id,'sequence',late.sequence::text,'receivedAt',late.received_at,
          'count',(SELECT count(*)::text FROM cash_late_recoveries rec WHERE rec.organization_id=cs.organization_id AND rec.cash_session_id=cs.id),
          'status',CASE WHEN EXISTS(SELECT 1 FROM cash_late_reviews lr WHERE lr.organization_id=cs.organization_id
            AND lr.cash_session_id=cs.id AND lr.through_operation_id=late.operation_id) THEN 'REVIEWED' ELSE 'PENDING_REVIEW' END) END AS "lateData",
        CASE WHEN cs.status='CLOSING' THEN t.close_attempt_id ELSE NULL END AS "closeAttemptId",
        CASE WHEN cs.status='OPEN' AND t.from_status='CLOSING' AND t.to_status='OPEN' THEN (
          SELECT prior.close_attempt_id FROM cash_session_state_transitions prior WHERE prior.organization_id=cs.organization_id
            AND prior.cash_session_id=cs.id AND prior.transition_sequence<t.transition_sequence AND prior.to_status='CLOSING'
          ORDER BY prior.transition_sequence DESC LIMIT 1) ELSE NULL END AS "lastAbortedAttemptId",
        jsonb_build_object('sequence',COALESCE((SELECT s.sequence::text FROM sync_operations s WHERE s.organization_id=cs.organization_id
          AND s.device_id=cs.device_id ORDER BY s.sequence DESC LIMIT 1),'0'),
          'headHash',COALESCE((SELECT s.operation_hash FROM sync_operations s WHERE s.organization_id=cs.organization_id
          AND s.device_id=cs.device_id ORDER BY s.sequence DESC LIMIT 1),repeat('0',64)),
          'sessionSequence',(SELECT count(*)::text FROM sync_operations s WHERE s.organization_id=cs.organization_id
          AND s.device_id=cs.device_id AND s.session_id=cs.id)) AS chain,
        CASE WHEN f.close_attempt_id IS NULL THEN NULL ELSE jsonb_build_object('ready',true,'expectedCash',f.expected_cash::text) END AS "finalSync",
        CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('expectedCash',c.expected_cash::text,'countedCash',c.counted_cash::text,
          'difference',c.difference::text,'reason',c.reason) END AS closure,
        CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('id',r.id,'status',CASE WHEN e.id IS NULL THEN 'PENDING_REVIEW' ELSE 'REVIEWED' END,
          'selfReview',c.actor_user_id=$4,'canReview',$3::boolean AND e.id IS NULL AND (c.actor_user_id<>$4 OR NOT EXISTS(
            SELECT 1 FROM memberships m WHERE m.organization_id=cs.organization_id AND m.user_id<>$4 AND m.status='ACTIVE' AND m.revoked_at IS NULL
            AND (m.role='OWNER' OR m.role='ADMIN' AND EXISTS(SELECT 1 FROM effective_membership_branch_scope bs
              WHERE bs.organization_id=m.organization_id AND bs.membership_id=m.id AND bs.branch_id=cs.branch_id))))) END AS "differenceReview"
        FROM cash_sessions cs JOIN cash_registers cr ON cr.organization_id=cs.organization_id AND cr.id=cs.cash_register_id
        JOIN devices d ON d.organization_id=cs.organization_id AND d.id=cs.device_id JOIN organizations o ON o.id=cs.organization_id
        LEFT JOIN cash_exceptional_closures x ON x.organization_id=cs.organization_id AND x.cash_session_id=cs.id
        LEFT JOIN LATERAL (SELECT rec.operation_id,rec.received_at,s.sequence FROM cash_late_recoveries rec JOIN sync_operations s
          ON s.organization_id=rec.organization_id AND s.id=rec.operation_id WHERE rec.organization_id=cs.organization_id
          AND rec.cash_session_id=cs.id ORDER BY s.sequence DESC LIMIT 1) late ON true
        LEFT JOIN LATERAL (SELECT st.close_attempt_id,st.from_status,st.to_status,st.transition_sequence FROM cash_session_state_transitions st WHERE st.organization_id=cs.organization_id
          AND st.cash_session_id=cs.id ORDER BY st.transition_sequence DESC LIMIT 1) t ON true
        LEFT JOIN cash_final_syncs f ON f.organization_id=cs.organization_id AND f.close_attempt_id=t.close_attempt_id AND cs.status='CLOSING'
        LEFT JOIN cash_session_closures c ON c.organization_id=cs.organization_id AND c.cash_session_id=cs.id
        LEFT JOIN cash_difference_reviews r ON r.organization_id=cs.organization_id AND r.cash_session_id=cs.id
        LEFT JOIN cash_difference_review_events e ON e.organization_id=r.organization_id AND e.review_id=r.id
        WHERE cs.organization_id=$1 AND cs.branch_id=$2 AND ($3::boolean OR cs.owner_user_id=$4)
          AND ($9::uuid IS NULL OR cs.id=$9::uuid)
          AND (($5='ACTIVE' AND cs.status IN ('OPEN','CLOSING','CONFLICTED'))
            OR ($5='FINAL' AND cs.status IN ('CLOSED','CLOSED_CONFLICT_RESOLVED','CLOSED_WITH_UNRECOVERED_DEVICE'))
            OR ($5='PENDING_REVIEW' AND (r.id IS NOT NULL AND e.id IS NULL OR late.operation_id IS NOT NULL AND NOT EXISTS(
              SELECT 1 FROM cash_late_reviews lr WHERE lr.organization_id=cs.organization_id AND lr.cash_session_id=cs.id AND lr.through_operation_id=late.operation_id))))
          AND ($6::timestamptz IS NULL OR (cs.opened_at,cs.id)<($6::timestamptz,$7::uuid))
        ORDER BY cs.opened_at DESC,cs.id DESC LIMIT $8`,
      [context.organizationId,branchId,actor.role!=='CASHIER',context.userId,input.view,pagination.cursor?.sortValue ?? null,
        pagination.cursor?.id ?? null,input.limit+1,input.sessionId ?? null]);
      const page=sessions.rows.slice(0,input.limit),last=page.at(-1);
      return {actorUserId:context.userId,registers:registers.rows,devices:devices.rows,
        nextCursor:sessions.rows.length>input.limit && last ? encodeCursor({id:last.id,sortValue:last.cursorTime}):null,
        sessions:page.map(({cursorTime,...row})=>{void cursorTime;return {...row,openedAt:row.openedAt.toISOString()};})};
    });
  }
}
