export class UserDto {
  id!: string;
  email!: string;
  name!: string | null;
  avatar!: string | null;
  createdAt!: Date;
}

export class AuthResponseDto {
  user!: UserDto;
  accessToken!: string;
}
