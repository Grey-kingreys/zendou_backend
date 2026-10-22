import { Module } from '@nestjs/common';
import { ApiKeysModule } from '../api-keys';
import { AuthModule } from '../auth/auth.module';
import { SessionOrApiKeyGuard } from '../common/session-or-api-key.guard';
import { EmailsLogController } from './emails-log.controller';
import { EmailsLogService } from './emails-log.service';

@Module({
  imports: [AuthModule, ApiKeysModule],
  controllers: [EmailsLogController],
  providers: [EmailsLogService, SessionOrApiKeyGuard],
})
export class EmailsLogModule {}
