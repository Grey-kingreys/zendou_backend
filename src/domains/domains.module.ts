import { Module } from '@nestjs/common';
import { AuthModule } from '../auth';
import { DomainsController } from './domains.controller';
import { DomainsService } from './domains.service';
import { sesIdentityDriverProvider } from './ses/ses-driver.factory';

@Module({
  imports: [AuthModule],
  controllers: [DomainsController],
  providers: [DomainsService, sesIdentityDriverProvider],
  exports: [DomainsService],
})
export class DomainsModule {}
