import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { WorkspaceRole } from '@workspace/shared';
import { GuestLinksService } from './guest-links.service';
import { CreateGuestLinkInput, GuestLinkType, ResolvedGuestLink } from './dto/guest-link.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/rbac/roles.guard';
import { Roles } from '../common/rbac/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/decorators/current-user.decorator';

@Resolver(() => GuestLinkType)
export class GuestLinksResolver {
  constructor(private readonly guestLinksService: GuestLinksService) {}

  // ADMIN+ only - creating a link that grants outside access is a
  // workspace-administration action.
  @Mutation(() => GuestLinkType)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  async createGuestLink(
    @Args('input') input: CreateGuestLinkInput,
    @CurrentUser() caller: RequestUser,
  ): Promise<GuestLinkType> {
    return this.guestLinksService.createGuestLink(
      caller.userId,
      input.workspaceId,
      input.permission,
      input.expiresAt,
    ) as unknown as Promise<GuestLinkType>;
  }

  // Intentionally unauthenticated - this IS the guest entry point.
  @Mutation(() => ResolvedGuestLink)
  async resolveGuestLink(@Args('token') token: string): Promise<ResolvedGuestLink> {
    return this.guestLinksService.resolveGuestLink(token) as unknown as Promise<ResolvedGuestLink>;
  }
}
