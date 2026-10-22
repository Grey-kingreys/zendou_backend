import { Module } from '@nestjs/common';
import { ApiKeysModule } from '../api-keys';
import { AuthModule } from '../auth';
import { SessionOrApiKeyGuard } from '../common/session-or-api-key.guard';
import { DomainsController } from './domains.controller';
import { DomainsService } from './domains.service';
import { sesIdentityDriverProvider } from './ses/ses-driver.factory';

@Module({
  imports: [AuthModule, ApiKeysModule],
  controllers: [DomainsController],
  providers: [DomainsService, SessionOrApiKeyGuard, sesIdentityDriverProvider],
  exports: [DomainsService],
})
export class DomainsModule {}
