import { Module } from '@nestjs/common';
import { CspReportController } from './csp-report.controller';

/**
 * Point de collecte des violations CSP. Aucun service, aucune dépendance :
 * la destination d'un rapport est le journal, pas la base - une page hostile
 * pourrait en émettre autant qu'elle veut.
 */
@Module({
  controllers: [CspReportController],
})
export class CspReportModule {}
