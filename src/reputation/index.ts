export { ReputationModule } from './reputation.module';
export { ReputationService } from './reputation.service';
export {
  MAX_BOUNCE_RATE,
  MAX_COMPLAINT_RATE,
  MIN_VOLUME_FOR_SANCTION,
  REPUTATION_WINDOW_DAYS,
  SEND_LIMIT_TIERS,
  WARNING_THRESHOLD_RATIO,
} from './reputation.constants';
export type {
  ReputationMetrics,
  ReputationOverview,
  ReputationVerdict,
} from './reputation.types';
