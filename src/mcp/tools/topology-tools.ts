import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { TopologyService } from '../../services/topology.service.js';
import { convertToMcpError } from '../errors.js';

/**
 * Wave 4.1 (task #318) — register the `topology_check` MCP tool.
 *
 * The tool exposes `TopologyService.classify` to MCP clients. It returns the
 * TopologyReport in both human-readable `content[0].text` form and structured
 * form (`structuredContent`) so clients can either render the advisory string
 * or branch on `topology` / `advisory` programmatically.
 *
 * Input schema rejects non-positive / non-integer project IDs at the SDK
 * layer — those never reach the service.
 */
export function registerTopologyTools(
  server: McpServer,
  topologyService: TopologyService,
): void {
  server.registerTool(
    'topology_check',
    {
      description:
        'Classify a project as FLAT (parallelizable, /tasks:loop), DAG ' +
        '(wave-by-wave parallel dispatch, /tasks:loop-dag), or DAG_CYCLIC ' +
        '(BLOCKED) based ' +
        'on its task_dependencies graph. Returns roots, leaves, edges, and ' +
        'an execution advisory.',
      inputSchema: z.object({
        project_id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        const report = topologyService.classify(args.project_id);

        return {
          content: [
            {
              type: 'text',
              text:
                `Project ${args.project_id}: topology=${report.topology}, ` +
                `advisory=${report.advisory}, ` +
                `edges=${report.edges.length}, ` +
                `roots=${report.roots.length}, ` +
                `leaves=${report.leaves.length}`,
            },
          ],
          structuredContent: report as unknown as Record<string, unknown>,
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    },
  );
}
