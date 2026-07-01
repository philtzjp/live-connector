import type { ScalarValue } from "../ast"
import type { GraphAdapter } from "../evaluator"

export type FakeNode = {
    id: number
    label: string
    props: Record<string, ScalarValue>
    edges: Record<string, number[]>
}

/**
 * SDK に依存しないインメモリのフェイク GraphAdapter。
 * `subtypes[abstract] = [concrete, ...]` で抽象ラベルのマッチを表現する。
 */
export class FakeGraph implements GraphAdapter<FakeNode> {
    constructor(
        private readonly nodes: FakeNode[],
        private readonly subtypes: Record<string, string[]> = {},
    ) {}

    private byId(id: number): FakeNode {
        const node = this.nodes.find((candidate) => candidate.id === id)
        if (node === undefined) {
            throw new Error(`fake graph has no node ${id}`)
        }
        return node
    }

    async seeds(label: string | null): Promise<FakeNode[]> {
        if (label === null) {
            return this.nodes
        }
        return this.nodes.filter((node) => this.matchesLabel(node, label))
    }

    async expand(node: FakeNode, relationshipTypes: string[]): Promise<FakeNode[]> {
        const out: FakeNode[] = []
        for (const type of relationshipTypes) {
            for (const id of node.edges[type] ?? []) {
                out.push(this.byId(id))
            }
        }
        return out
    }

    labelOf(node: FakeNode): string {
        return node.label
    }

    matchesLabel(node: FakeNode, label: string): boolean {
        return node.label === label || (this.subtypes[label] ?? []).includes(node.label)
    }

    async getProperty(node: FakeNode, property: string): Promise<ScalarValue> {
        return node.props[property] ?? null
    }

    async serialize(node: FakeNode): Promise<Record<string, unknown>> {
        return { _label: node.label, ...node.props }
    }

    identity(node: FakeNode): unknown {
        return node.id
    }
}
