import { ForbiddenException, UseGuards } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { UsersService } from './users.service';
import { UserType } from '../auth/dto/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestGuest, RequestUser } from '../common/decorators/current-user.decorator';

@Resolver(() => UserType)
@UseGuards(JwtAuthGuard)
export class UsersResolver {
  constructor(private readonly usersService: UsersService) {}

  @Query(() => UserType)
  async me(@CurrentUser() caller: RequestUser | RequestGuest): Promise<UserType> {
    if ('guest' in caller && caller.guest) {
      throw new ForbiddenException('Guests do not have a user profile');
    }
    return this.usersService.findById(caller.userId) as unknown as Promise<UserType>;
  }

  /** Only visible if the caller shares at least one workspace with the target user. */
  @Query(() => UserType)
  async user(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() caller: RequestUser | RequestGuest,
  ): Promise<UserType> {
    if ('guest' in caller && caller.guest) {
      throw new ForbiddenException('Guests cannot browse users');
    }
    const canView = await this.usersService.shareWorkspace(caller.userId, id);
    if (!canView) {
      throw new ForbiddenException('You do not share a workspace with this user');
    }
    return this.usersService.findById(id) as unknown as Promise<UserType>;
  }
}
