import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { WorkspaceRole } from '@workspace/shared';
import { WorkspacesService } from './workspaces.service';
import { CreateWorkspaceInput, InviteMemberInput, WorkspaceMemberType, WorkspaceType } from './dto/workspace.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/rbac/roles.guard';
import { Roles } from '../common/rbac/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/decorators/current-user.decorator';

@Resolver(() => WorkspaceType)
@UseGuards(JwtAuthGuard)
export class WorkspacesResolver {
  constructor(private readonly workspacesService: WorkspacesService) {}

  @Mutation(() => WorkspaceType)
  async createWorkspace(
    @Args('input') input: CreateWorkspaceInput,
    @CurrentUser() caller: RequestUser,
  ): Promise<WorkspaceType> {
    return this.workspacesService.createWorkspace(caller.userId, input.name) as unknown as Promise<WorkspaceType>;
  }

  @Query(() => [WorkspaceType])
  async myWorkspaces(@CurrentUser() caller: RequestUser): Promise<WorkspaceType[]> {
    return this.workspacesService.myWorkspaces(caller.userId) as unknown as Promise<WorkspaceType[]>;
  }

  @Query(() => WorkspaceType)
  async workspace(
    @Args('id', { type: () => ID }) id: string,
    @CurrentUser() caller: RequestUser,
  ): Promise<WorkspaceType> {
    return this.workspacesService.getWorkspaceWithMembers(id, caller.userId) as unknown as Promise<WorkspaceType>;
  }

  // ADMIN+ only (OWNER outranks ADMIN in privilege, but RolesGuard checks
  // *membership* against this explicit allow-list, so OWNER must be listed
  // too - see RolesGuard doc comment).
  @Mutation(() => WorkspaceMemberType)
  @UseGuards(RolesGuard)
  @Roles(WorkspaceRole.OWNER, WorkspaceRole.ADMIN)
  async inviteMember(@Args('input') input: InviteMemberInput): Promise<WorkspaceMemberType> {
    return this.workspacesService.inviteMember(
      input.workspaceId,
      input.email,
      input.role,
    ) as unknown as Promise<WorkspaceMemberType>;
  }
}
