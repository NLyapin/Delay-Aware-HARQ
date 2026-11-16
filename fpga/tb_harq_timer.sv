`timescale 1ns/1ps
module tb_harq_timer;
    reg clk=0; always #5 clk=~clk;
    reg rst=1, arm_valid=0, feedback_valid=0, feedback_ack=1, event_ready=1;
    reg [1:0] arm_pid=0, feedback_pid=0;
    reg [31:0] arm_tag=0, feedback_tag=0, timeout_cycles=0;
    wire arm_ready, feedback_ready, event_valid;
    wire [1:0] event_pid,event_kind;
    wire [31:0] event_tag;
    harq_timer #(.PROCESSES(4),.PID_WIDTH(2)) dut(.*);
    task arm(input [1:0] pid,input [31:0] token,input [31:0] cycles);
        begin @(negedge clk);arm_pid=pid;arm_tag=token;timeout_cycles=cycles;arm_valid=1;
        @(negedge clk);arm_valid=0; end
    endtask
    initial begin
        repeat(2) @(negedge clk);rst=0;
        arm(1,32'h11,10);
        feedback_pid=1;feedback_tag=32'h10;feedback_valid=1;
        @(negedge clk);feedback_valid=0;
        if(event_valid) $fatal(1,"Stale feedback was accepted");
        feedback_tag=32'h11;feedback_valid=1;
        @(negedge clk);feedback_valid=0;
        if(!event_valid || event_kind!=0 || event_pid!=1) $fatal(1,"ACK missing");
        @(negedge clk);event_ready=0;
        arm(2,32'h22,1);
        @(negedge clk);
        if(!event_valid || event_kind!=2 || event_tag!=32'h22) $fatal(1,"Timeout missing");
        repeat(3) begin @(negedge clk);if(!event_valid || event_tag!=32'h22) $fatal(1,"Backpressure lost event");end
        event_ready=1;@(negedge clk);
        if(event_valid) $fatal(1,"Event not consumed");
        $display("PASS: stale ACK, ACK, timeout, backpressure");$finish;
    end
    initial begin #10000;$fatal(1,"Testbench watchdog");end
endmodule
