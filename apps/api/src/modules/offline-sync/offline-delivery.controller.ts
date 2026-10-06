import { Body, Controller, ForbiddenException, HttpCode, Post, Req, ServiceUnavailableException } from '@nestjs/common';

import { CsrfExempt, PublicRoute } from '../auth/index.js';
import { DeliveryRejectedError, OfflineDeliveryService } from './offline-delivery.service.js';

interface Request { readonly socket: { readonly remoteAddress?: string } }

@Controller('offline/delivery')
export class OfflineDeliveryController {
  constructor(private readonly service: OfflineDeliveryService) {}
  @Post('challenge') @HttpCode(200) @CsrfExempt() @PublicRoute()
  challenge(@Body() body: unknown, @Req() request: Request) { return this.execute(() => this.service.challenge(body,request.socket.remoteAddress ?? 'unknown')); }
  @Post('push') @HttpCode(200) @CsrfExempt() @PublicRoute()
  push(@Body() body: unknown, @Req() request: Request) { return this.execute(() => this.service.push(body,request.socket.remoteAddress ?? 'unknown')); }
  private async execute<T>(operation: () => Promise<T>) {
    try { return await operation(); }
    catch (error) {
      if (error instanceof DeliveryRejectedError) throw new ForbiddenException({ code:'OFFLINE_DELIVERY_REJECTED',title:'Entrega rechazada',detail:'La entrega no pudo validarse.' });
      throw new ServiceUnavailableException({code:'OFFLINE_DELIVERY_UNAVAILABLE',title:'Entrega no disponible',detail:'Conservá los sobres pendientes y reintentá.'});
    }
  }
}
