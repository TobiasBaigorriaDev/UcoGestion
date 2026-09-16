import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';

import { AuthController } from './auth.controller.js';
import { LoginService } from './login.service.js';

@Injectable()
class GlobalAuthDatabase implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

@Module({
  controllers: [AuthController],
  providers: [
    GlobalAuthDatabase,
    {
      provide: LoginService,
      useFactory: (database: GlobalAuthDatabase) => new LoginService(database.pool),
      inject: [GlobalAuthDatabase],
    },
  ],
})
export class AuthModule {}
