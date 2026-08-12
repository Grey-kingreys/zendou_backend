import { Module } from '@nestjs/common';
import { CaptchaGuard } from './captcha.guard';
import { CaptchaService } from './captcha.service';

@Module({
  providers: [CaptchaService, CaptchaGuard],
  exports: [CaptchaService, CaptchaGuard],
})
export class CaptchaModule {}
