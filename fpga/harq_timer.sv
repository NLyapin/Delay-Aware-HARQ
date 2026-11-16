// Reference control block only. Integrate with AXI/DMA/modem in a board-specific ADI HDL project.
// One outstanding transaction per process; tag rejects feedback from a previous generation.
module harq_timer #(
    parameter integer PROCESSES = 16,
    parameter integer PID_WIDTH = 4
) (
    input wire clk, input wire rst,
    input wire arm_valid, output wire arm_ready,
    input wire [PID_WIDTH-1:0] arm_pid,
    input wire [31:0] arm_tag, input wire [31:0] timeout_cycles,
    input wire feedback_valid, output wire feedback_ready,
    input wire [PID_WIDTH-1:0] feedback_pid,
    input wire [31:0] feedback_tag, input wire feedback_ack,
    output reg event_valid, input wire event_ready,
    output reg [PID_WIDTH-1:0] event_pid,
    output reg [31:0] event_tag,
    output reg [1:0] event_kind // 0 ACK, 1 NACK, 2 TIMEOUT
);
    reg [PROCESSES-1:0] busy;
    reg [31:0] timer [0:PROCESSES-1];
    reg [31:0] tag [0:PROCESSES-1];
    integer i;
    integer winner;
    wire slot_free = !event_valid || event_ready;
    assign arm_ready = (arm_pid < PROCESSES) && !busy[arm_pid];
    assign feedback_ready = slot_free;
    always @(posedge clk) begin
        if (rst) begin
            busy <= 0; event_valid <= 0; event_pid <= 0; event_tag <= 0; event_kind <= 0;
            for (i=0; i<PROCESSES; i=i+1) begin timer[i] <= 0; tag[i] <= 0; end
        end else begin
            if (event_valid && event_ready) event_valid <= 0;
            for (i=0; i<PROCESSES; i=i+1)
                if (busy[i] && timer[i] != 0) timer[i] <= timer[i]-1;
            if (arm_valid && arm_ready) begin
                busy[arm_pid] <= 1;
                tag[arm_pid] <= arm_tag;
                timer[arm_pid] <= (timeout_cycles == 0) ? 0 : timeout_cycles-1;
            end
            if (slot_free) begin
                if (feedback_valid && feedback_pid < PROCESSES && busy[feedback_pid]
                    && tag[feedback_pid] == feedback_tag) begin
                    event_valid <= 1; event_pid <= feedback_pid; event_tag <= feedback_tag;
                    event_kind <= feedback_ack ? 0 : 1; busy[feedback_pid] <= 0;
                end else begin
                    winner = -1;
                    for (i=PROCESSES-1; i>=0; i=i-1)
                        if (busy[i] && timer[i] == 0) winner = i;
                    if (winner >= 0) begin
                        event_valid <= 1; event_pid <= winner; event_tag <= tag[winner];
                        event_kind <= 2; busy[winner] <= 0;
                    end
                end
            end
        end
    end
endmodule
