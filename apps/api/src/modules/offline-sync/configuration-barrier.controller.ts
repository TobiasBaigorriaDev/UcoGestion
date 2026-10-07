import { randomUUID } from 'node:crypto';
import { Body,ConflictException,Controller,ForbiddenException,Get,Param,ParseUUIDPipe,Post,Query,Req,UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { requireIdempotencyKey } from '../../core/validation/idempotency-key.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import { TenantTransaction } from '../../database/tenant-transaction.js';
import { ConfigurationBarrierService,ConfigurationBarrierError } from './configuration-barrier.service.js';
const checkpoint=z.strictObject({grantId:z.uuid(),sequence:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),headHash:z.string().regex(/^[0-9a-f]{64}$/),signature:z.string().max(200)});
interface Request {identity?:{organizationId:string;userId:string};headers:Record<string,string|string[]|undefined>}
@Controller('offline/configuration-barriers')
export class ConfigurationBarrierController {
  private readonly service:ConfigurationBarrierService;
  constructor(transactions:TenantTransaction) {this.service=new ConfigurationBarrierService(transactions);}
  @Post()
  begin(@Req() request:Request) {return this.execute(()=>this.service.begin(this.context(request),requireIdempotencyKey(request.headers)));}
  @Get(':id/grants')
  grants(@Req() request:Request,@Param('id',ParseUUIDPipe) id:string,@Query('deviceId',ParseUUIDPipe) deviceId:string) {
    return this.execute(()=>this.service.pendingGrants(this.context(request),id,deviceId));
  }
  @Post(':id/checkpoints')
  async checkpoint(@Req() request:Request,@Param('id',ParseUUIDPipe) id:string,@Body(new ZodValidationPipe(checkpoint)) body:z.infer<typeof checkpoint>) {
    await this.execute(()=>this.service.submitCheckpoint(this.context(request),id,body,requireIdempotencyKey(request.headers)));return {recorded:true};
  }
  @Post(':id/complete')
  async complete(@Req() request:Request,@Param('id',ParseUUIDPipe) id:string) {
    await this.execute(()=>this.service.complete(this.context(request),id,requireIdempotencyKey(request.headers)));return {completed:true};
  }
  private context(request:Request) {if (!request.identity) throw new UnauthorizedException();return {...request.identity,requestId:randomUUID()};}
  private async execute<T>(operation:()=>Promise<T>) {
    try {return await operation();} catch(error) {
      if (error instanceof ConfigurationBarrierError) {
        const problem={code:error.code,title:'Barrera de configuración',detail:error.message};
        if (error.code==='CONFIGURATION_BARRIER_FORBIDDEN') throw new ForbiddenException(problem);
        throw new ConflictException(problem);
      }
      throw error;
    }
  }
}
