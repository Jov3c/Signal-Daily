/**
 * PrismaModule — `@Global()`，这样任何模块都能直接注入 `PrismaService`，
 * 不必每个模块都 import 一次（也就不会出现「谁忘了 import」的接线故障）。
 *
 * 归属：Agent 02 落地，下游复用。
 */

import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
