import { apiClient } from './client';

interface User {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  createdAt: string;
}

interface AuthResponse {
  user: User;
  accessToken: string;
}

interface RegisterDto {
  email: string;
  password: string;
  confirmPassword: string;
}

interface LoginDto {
  email: string;
  password: string;
}

export const authApi = {
  /**
   * 用户注册
   */
  async register(dto: RegisterDto): Promise<AuthResponse> {
    // 只发送后端需要的字段（不包含 confirmPassword）
    const { email, password } = dto;
    return apiClient<AuthResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      skipAuth: true,
    });
  },

  /**
   * 用户登录
   */
  async login(dto: LoginDto): Promise<AuthResponse> {
    return apiClient<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(dto),
      skipAuth: true,
    });
  },

  /**
   * 获取当前用户信息
   */
  async getMe(): Promise<User> {
    return apiClient<User>('/auth/me', {
      method: 'GET',
    });
  },

  /**
   * 退出登录（客户端操作）
   */
  logout() {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('accessToken');
      // 清除 Cookie
      document.cookie = 'accessToken=; path=/; max-age=0';
    }
  },
};
