import { LOM_SCHEMA } from "./schema"
import type { NodeLabelDef, PropertyDef } from "./types"

const NODE_BY_LABEL = new Map<string, NodeLabelDef>(
    LOM_SCHEMA.nodes.map((node) => [node.label, node]),
)

/** ラベル定義を返す（未知ラベルは undefined）。 */
export function getNodeDef(label: string): NodeLabelDef | undefined {
    return NODE_BY_LABEL.get(label)
}

/** 継承を含めたプロパティ一覧を返す（基底→派生の順、同名は派生優先）。 */
export function propertiesForLabel(label: string): PropertyDef[] {
    const chain: NodeLabelDef[] = []
    let current = NODE_BY_LABEL.get(label)
    while (current !== undefined) {
        chain.unshift(current)
        current = current.extends === undefined ? undefined : NODE_BY_LABEL.get(current.extends)
    }
    const merged = new Map<string, PropertyDef>()
    for (const node of chain) {
        for (const property of node.properties) {
            merged.set(property.name, property)
        }
    }
    return [...merged.values()]
}

/** `label` が `ancestor` と同一、もしくはその子孫（extends 連鎖）かを返す。 */
export function isSubtypeOf(label: string, ancestor: string): boolean {
    let current: string | undefined = label
    while (current !== undefined) {
        if (current === ancestor) {
            return true
        }
        current = NODE_BY_LABEL.get(current)?.extends
    }
    return false
}
