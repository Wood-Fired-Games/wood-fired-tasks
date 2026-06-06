/**
 * CycleDetector - uses DFS to detect circular dependencies in directed graphs
 */
export class CycleDetector {
  private adjacencyList: Map<number, Set<number>>;

  /**
   * @param edges - array of dependency edges (from task_id to blocks_task_id)
   */
  constructor(edges: Array<{ task_id: number; blocks_task_id: number }>) {
    this.adjacencyList = new Map();

    // Build adjacency list representation
    for (const edge of edges) {
      if (!this.adjacencyList.has(edge.task_id)) {
        this.adjacencyList.set(edge.task_id, new Set());
      }
      this.adjacencyList.get(edge.task_id)!.add(edge.blocks_task_id);
    }
  }

  /**
   * Check if adding an edge from -> to would create a cycle
   */
  wouldCreateCycle(from: number, to: number): boolean {
    // Temporarily add the edge
    if (!this.adjacencyList.has(from)) {
      this.adjacencyList.set(from, new Set());
    }
    this.adjacencyList.get(from)!.add(to);

    // Check for cycle
    const hasCycle = this.detectCycle();

    // Remove the temporary edge
    this.adjacencyList.get(from)!.delete(to);
    if (this.adjacencyList.get(from)!.size === 0) {
      this.adjacencyList.delete(from);
    }

    return hasCycle;
  }

  /**
   * Detect if the graph contains a cycle using DFS
   */
  private detectCycle(): boolean {
    const visited = new Set<number>();
    const recStack = new Set<number>();

    // Get all nodes (both sources and targets)
    const allNodes = new Set<number>();
    for (const [node, neighbors] of this.adjacencyList.entries()) {
      allNodes.add(node);
      neighbors.forEach((n) => allNodes.add(n));
    }

    // Run DFS from each unvisited node
    for (const node of allNodes) {
      if (!visited.has(node)) {
        if (this.dfs(node, visited, recStack)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * DFS with recursion stack to detect back edges (cycles)
   */
  private dfs(node: number, visited: Set<number>, recStack: Set<number>): boolean {
    visited.add(node);
    recStack.add(node);

    // Visit all neighbors
    const neighbors = this.adjacencyList.get(node);
    if (neighbors) {
      for (const neighbor of neighbors) {
        // If neighbor is in recursion stack, we found a back edge (cycle)
        if (recStack.has(neighbor)) {
          return true;
        }

        // If neighbor not visited, recurse
        if (!visited.has(neighbor)) {
          if (this.dfs(neighbor, visited, recStack)) {
            return true;
          }
        }
      }
    }

    // Remove from recursion stack before returning
    recStack.delete(node);
    return false;
  }
}
