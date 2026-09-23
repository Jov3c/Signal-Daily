/**
 * UsersService —— 用户身份读取。
 *
 * 只负责「我是谁」。收藏 / 阅读进度 / 阅读偏好属于 Agent 09，不在这里实现。
 */

import { Inject, Injectable } from '@nestjs/common';
import { AppError, DomainErrorCode } from '@signal/contracts';
import { USER_REPOSITORY, type UserRepository } from './user.repository';
import { toMeDto, type MeDto } from './dto/me.dto';

@Injectable()
export class UsersService {
  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepository) {}

  /** `GET /me`。用户不存在时 404 —— 例如 token 有效但用户已被删除。 */
  async getMe(userId: string): Promise<MeDto> {
    const user = await this.users.findById(userId);
    if (user === null) {
      throw new AppError({
        code: DomainErrorCode.USER_NOT_FOUND,
        httpStatus: 404,
        safeMessage: 'User not found',
      });
    }
    return toMeDto(user);
  }
}
