// The provider sends a short error code to the account or service callback.
// A denial alone does not say whether the owner declined or the account was blocked.
export function signInRefusal(service: string, code: string, again: string): string {
  switch (code) {
    case 'access_denied':
      return `${service} did not grant access. If you expected access, check with the person who manages the account. ${again}`;
    case 'server_error':
    case 'temporarily_unavailable':
      return `${service} could not finish sign-in just now. Wait a little. ${again}`;
    case 'unauthorized_client':
    case 'unsupported_response_type':
    case 'invalid_scope':
      return `${service} rejected Oddboro's sign-in request (${code}). This is a problem in Oddboro, not your account. Report a bug with this code.`;
    default:
      return `${service} said: ${code}. ${again}`;
  }
}
