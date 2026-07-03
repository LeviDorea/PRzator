export function getCredentials(): { user: string; password: string } | null {
  if (typeof window === 'undefined') return null;
  const user = localStorage.getItem('api_user');
  const password = localStorage.getItem('api_password');
  if (!user || !password) return null;
  return { user, password };
}

export function setCredentials(user: string, password: string): void {
  localStorage.setItem('api_user', user);
  localStorage.setItem('api_password', password);
}

export function clearCredentials(): void {
  localStorage.removeItem('api_user');
  localStorage.removeItem('api_password');
}

export function isAuthenticated(): boolean {
  return getCredentials() !== null;
}
