import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailsLogController } from './emails-log.controller';
import { EmailsLogService } from './emails-log.service';

@Module({
  imports: [AuthModule],
  controllers: [EmailsLogController],
  providers: [EmailsLogService],
})
export class EmailsLogModule {}
