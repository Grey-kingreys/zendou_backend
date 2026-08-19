import { Module } from '@nestjs/common';
import { AuthModule } from '../auth';
import { SmtpCredentialsController } from './smtp-credentials.controller';
import { SmtpCredentialsService } from './smtp-credentials.service';

@Module({
  imports: [AuthModule],
  controllers: [SmtpCredentialsController],
  providers: [SmtpCredentialsService],
  exports: [SmtpCredentialsService],
})
export class SmtpCredentialsModule {}
