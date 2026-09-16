import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  getDescriptor() {
    return {
      service: 'uconext-api',
      version: 'v1',
    };
  }
}
