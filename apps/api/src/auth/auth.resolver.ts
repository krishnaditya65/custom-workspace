import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { AuthService } from './auth.service';
import { AuthPayload, LoginInput, RefreshTokenInput, RegisterInput } from './dto/auth.types';

@Resolver()
export class AuthResolver {
  constructor(private readonly authService: AuthService) {}

  @Mutation(() => AuthPayload)
  async register(@Args('input') input: RegisterInput): Promise<AuthPayload> {
    const result = await this.authService.register(input.email, input.password, input.displayName);
    return result;
  }

  @Mutation(() => AuthPayload)
  async login(@Args('input') input: LoginInput): Promise<AuthPayload> {
    const result = await this.authService.login(input.email, input.password);
    return result;
  }

  @Mutation(() => AuthPayload)
  async refreshToken(@Args('input') input: RefreshTokenInput): Promise<AuthPayload> {
    const result = await this.authService.refreshToken(input.refreshToken);
    return result;
  }

  @Mutation(() => Boolean)
  async logout(@Args('input') input: RefreshTokenInput): Promise<boolean> {
    return this.authService.logout(input.refreshToken);
  }
}
