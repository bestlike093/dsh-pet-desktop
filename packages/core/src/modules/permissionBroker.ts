import { ALL_PERMISSIONS, ErrorCode, PetError } from '@pet/shared'
import type { Permission } from '@pet/shared'

export interface PermissionAuditEntry {
  readonly permission: Permission
  readonly action: 'grant' | 'revoke' | 'deny'
  readonly at: number
}

const ALLOWED = new Set<string>(ALL_PERMISSIONS)

function assertKnown(permissions: readonly string[]): asserts permissions is readonly Permission[] {
  for (const permission of permissions) {
    if (!ALLOWED.has(permission)) {
      throw new PetError(ErrorCode.INVALID_ARGUMENT, `未知权限：${permission}`)
    }
  }
}

/**
 * 运行时权限执行器。
 * 类型白名单只负责编译期，这里负责运行期：没有授予过的权限，调用即失败。
 */
export class PermissionBroker {
  private readonly granted = new Set<Permission>()
  private readonly history: PermissionAuditEntry[] = []
  private readonly now: () => number

  constructor(initial: readonly Permission[] = [], now: () => number = Date.now) {
    assertKnown(initial)
    for (const permission of initial) this.granted.add(permission)
    this.now = now
  }

  has(permission: Permission): boolean {
    return this.granted.has(permission)
  }

  hasAll(permissions: readonly Permission[]): boolean {
    return permissions.every((permission) => this.granted.has(permission))
  }

  /** 未授权直接抛 PERMISSION_DENIED；details 里带权限名，便于诊断面板定位。 */
  assert(permission: Permission): void {
    if (!this.granted.has(permission)) {
      this.recordDenied(permission)
      throw new PetError(ErrorCode.PERMISSION_DENIED, `未授予权限：${permission}`, {
        details: { permission }
      })
    }
  }

  /** 记录一次被拒绝的权限访问；运行期与启动期共用同一条审计口径。 */
  recordDenied(permission: Permission): void {
    this.history.push({ permission, action: 'deny', at: this.now() })
  }

  assertAll(permissions: readonly Permission[]): void {
    for (const permission of permissions) this.assert(permission)
  }

  grant(permissions: readonly Permission[]): void {
    assertKnown(permissions)
    for (const permission of permissions) {
      if (this.granted.has(permission)) continue
      this.granted.add(permission)
      this.history.push({ permission, action: 'grant', at: this.now() })
    }
  }

  revoke(permissions: readonly Permission[]): void {
    assertKnown(permissions)
    for (const permission of permissions) {
      if (!this.granted.delete(permission)) continue
      this.history.push({ permission, action: 'revoke', at: this.now() })
    }
  }

  /** 覆盖式设置：与当前集合求差，逐项记录审计。 */
  replace(permissions: readonly Permission[]): void {
    assertKnown(permissions)
    const next = new Set<Permission>(permissions)
    const toRevoke = [...this.granted].filter((permission) => !next.has(permission))
    const toGrant = [...next].filter((permission) => !this.granted.has(permission))
    this.revoke(toRevoke)
    this.grant(toGrant)
  }

  snapshot(): readonly Permission[] {
    return [...this.granted]
  }

  audit(): readonly PermissionAuditEntry[] {
    return [...this.history]
  }
}
