import { Module } from '@nestjs/common';
import { AdminSeedService } from './admin-seed.service';

@Module({
  providers: [AdminSeedService],
})
export class SeedModule {}
