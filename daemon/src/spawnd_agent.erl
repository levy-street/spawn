-module(spawnd_agent).
-behaviour(gen_server).

-include_lib("kernel/include/file.hrl").

-export([start_link/1, stdin/2, resize/3, snapshot/2, redraw/1, stop_agent/1, status/1]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2, code_change/3]).

-define(MAX_BUFFER, 2097152).
-define(STOP_TIMEOUT_MS, 3000).

-record(state, {
    agent_id,
    argv = [],
    cwd = ".",
    env = [],
    rows = 32,
    cols = 120,
    proc_pid = undefined,
    os_pid = undefined,
    buffer = <<>>,
    notify = undefined,
    report = true
}).

start_link(Spec) ->
    gen_server:start_link(?MODULE, Spec, []).

stdin(Pid, Bytes) ->
    gen_server:cast(Pid, {stdin, iolist_to_binary(Bytes)}).

resize(Pid, Cols, Rows) ->
    gen_server:cast(Pid, {resize, Cols, Rows}).

snapshot(Pid, Lines) ->
    gen_server:call(Pid, {snapshot, Lines}, 5000).

redraw(Pid) ->
    gen_server:cast(Pid, redraw).

stop_agent(Pid) ->
    gen_server:cast(Pid, stop_agent).

status(Pid) ->
    gen_server:call(Pid, status, 1000).

init(Spec) ->
    process_flag(trap_exit, true),
    AgentId = maps:get(agent_id, Spec),
    Argv = maps:get(argv, Spec, []),
    Cwd = maps:get(cwd, Spec, spawnd_config:home_dir()),
    Env = maps:get(env, Spec, []),
    Cols = maps:get(cols, Spec, 120),
    Rows = maps:get(rows, Spec, 32),
    Notify = maps:get(notify, Spec, undefined),
    Report = maps:get(report, Spec, true),
    case Argv of
        [] ->
            {stop, empty_argv};
        [Exe0 | Args] ->
            EnvList = normalize_env(Env),
            Exe = resolve_executable(Exe0, EnvList),
            Cmd = [Exe | [binary_or_list(A) || A <- Args]],
            Opts = [
                stdin,
                stdout,
                {stderr, stdout},
                pty,
                monitor,
                kill_group,
                {kill_timeout, 1},
                {winsz, {Rows, Cols}},
                {cd, binary_or_list(Cwd)},
                {env, EnvList}
            ],
            case exec:run_link(Cmd, Opts) of
                {ok, ProcPid, OsPid} ->
                    maybe_report(Report, #{
                        <<"type">> => <<"agent.started">>,
                        <<"agent_id">> => AgentId,
                        <<"pid">> => OsPid
                    }),
                    maybe_notify(Notify, {agent_started, AgentId, OsPid}),
                    {ok, #state{
                        agent_id = AgentId,
                        argv = Argv,
                        cwd = Cwd,
                        env = Env,
                        rows = Rows,
                        cols = Cols,
                        proc_pid = ProcPid,
                        os_pid = OsPid,
                        notify = Notify,
                        report = Report
                    }};
                {error, Reason} ->
                    {stop, Reason}
            end
    end.

handle_call({snapshot, Lines}, _From, State = #state{buffer = Buffer}) ->
    {reply, tail_lines(Buffer, Lines), State};
handle_call(status, _From, State = #state{agent_id = AgentId, os_pid = OsPid}) ->
    {reply, #{<<"agent_id">> => AgentId, <<"pid">> => integer_to_binary(OsPid)}, State}.

handle_cast({stdin, Bytes}, State = #state{os_pid = OsPid}) when OsPid =/= undefined ->
    exec:send(OsPid, Bytes),
    {noreply, State};
handle_cast({resize, Cols, Rows}, State = #state{os_pid = OsPid}) ->
    _ = exec:winsz(OsPid, Rows, Cols),
    {noreply, State#state{cols = Cols, rows = Rows}};
handle_cast(redraw, State = #state{os_pid = OsPid, rows = Rows, cols = Cols}) ->
    _ = exec:winsz(OsPid, Rows, Cols),
    {noreply, State};
handle_cast(stop_agent, State = #state{os_pid = OsPid}) ->
    Reason =
        case catch exec:stop_and_wait(OsPid, ?STOP_TIMEOUT_MS) of
            {'EXIT', Error} -> Error;
            Result -> Result
        end,
    finish_exit(Reason, State#state{os_pid = undefined}).

handle_info({stdout, _OsPid, Data}, State) ->
    output(Data, State);
handle_info({stderr, _OsPid, Data}, State) ->
    output(Data, State);
handle_info({'DOWN', _OsPid, process, _Pid, Reason}, State) ->
    finish_exit(Reason, State);
handle_info({'EXIT', _Pid, Reason}, State) ->
    finish_exit(Reason, State);
handle_info(_Msg, State) ->
    {noreply, State}.

terminate(_Reason, #state{os_pid = undefined}) ->
    ok;
terminate(_Reason, #state{os_pid = OsPid}) ->
    _ = catch exec:stop(OsPid),
    ok.

code_change(_OldVsn, State, _Extra) ->
    {ok, State}.

finish_exit(Reason, State = #state{agent_id = AgentId, report = Report}) ->
    {ExitCode, Signal} = decode_exit(Reason),
    maybe_report(Report, #{
        <<"type">> => <<"agent.exit">>,
        <<"agent_id">> => AgentId,
        <<"exit_code">> => ExitCode,
        <<"signal">> => Signal
    }),
    maybe_notify(State#state.notify, {agent_exit, AgentId, Reason}),
    spawnd_registry:unregister(AgentId, self()),
    {stop, normal, State#state{os_pid = undefined}}.

output(Data0, State = #state{agent_id = AgentId, buffer = Buffer, report = Report}) ->
    Data = iolist_to_binary(Data0),
    case Report of
        true -> spawnd_ws:send_binary(spawnd_frames:encode_output(AgentId, Data));
        false -> ok
    end,
    {noreply, State#state{buffer = trim_buffer(<<Buffer/binary, Data/binary>>)}}.

trim_buffer(Bin) when byte_size(Bin) =< ?MAX_BUFFER ->
    Bin;
trim_buffer(Bin) ->
    binary:part(Bin, byte_size(Bin) - ?MAX_BUFFER, ?MAX_BUFFER).

tail_lines(Buffer, undefined) ->
    Buffer;
tail_lines(Buffer, Lines) when Lines =< 0 ->
    Buffer;
tail_lines(Buffer, Lines) ->
    Parts = binary:split(Buffer, <<"\n">>, [global]),
    Tail = lists:nthtail(max(0, length(Parts) - Lines), Parts),
    iolist_to_binary(lists:join(<<"\n">>, Tail)).

decode_exit(normal) ->
    {0, null};
decode_exit({status, Status}) ->
    case exec:status(Status) of
        {status, Code} -> {Code, null};
        {signal, Signal, _Core} -> {null, list_to_binary(io_lib:format("~p", [Signal]))}
    end;
decode_exit(Reason) ->
    {null, list_to_binary(io_lib:format("~p", [Reason]))}.

normalize_env(Map) when is_map(Map) ->
    [{binary_or_list(K), binary_or_list(V)} || {K, V} <- maps:to_list(Map)];
normalize_env(List) when is_list(List) ->
    [{binary_or_list(K), binary_or_list(V)} || {K, V} <- List].

binary_or_list(Bin) when is_binary(Bin) ->
    binary_to_list(Bin);
binary_or_list(List) when is_list(List) ->
    List;
binary_or_list(Other) ->
    binary_to_list(iolist_to_binary(io_lib:format("~p", [Other]))).

resolve_executable(Exe0, Env) ->
    Exe = binary_or_list(Exe0),
    case filename:pathtype(Exe) of
        absolute -> Exe;
        _ ->
            case find_in_agent_path(Exe, Env) of
                false ->
                    case os:find_executable(Exe) of
                        false -> Exe;
                        Path -> Path
                    end;
                Path -> Path
            end
    end.

find_in_agent_path(Exe, Env) ->
    case lists:keyfind("PATH", 1, Env) of
        {"PATH", Path} -> find_in_path(Exe, Path);
        false -> false
    end.

find_in_path(Exe, Path) ->
    lists:foldl(
        fun
            (_Dir, Found) when Found =/= false ->
                Found;
            ("", false) ->
                false;
            (Dir, false) ->
                Candidate = filename:join(Dir, Exe),
                case filelib:is_regular(Candidate) andalso filelib:is_file(Candidate) of
                    true ->
                        case file:read_file_info(Candidate) of
                            {ok, #file_info{mode = Mode}} when Mode band 8#111 =/= 0 -> Candidate;
                            _ -> false
                        end;
                    false ->
                        false
                end
        end,
        false,
        string:split(Path, ":", all)
    ).

maybe_notify(undefined, _Msg) ->
    ok;
maybe_notify(Pid, Msg) when is_pid(Pid) ->
    Pid ! Msg,
    ok.

maybe_report(true, Msg) ->
    spawnd_ws:send_json(Msg);
maybe_report(false, _Msg) ->
    ok.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

tail_lines_test() ->
    ?assertEqual(<<"b\nc">>, tail_lines(<<"a\nb\nc">>, 2)),
    ?assertEqual(<<"a\nb\nc">>, tail_lines(<<"a\nb\nc">>, 10)).

direct_subprocess_lifecycle_test() ->
    {ok, _} = application:ensure_all_started(erlexec),
    Spec = #{
        agent_id => <<"00000000-0000-0000-0000-000000000001">>,
        argv => [<<"/bin/sh">>, <<"-lc">>, <<"printf ready; sleep 0.1">>],
        cwd => <<"/tmp">>,
        env => #{},
        cols => 80,
        rows => 24,
        notify => self()
    },
    {ok, Pid} = spawnd_agent:start_link(Spec),
    receive
        {agent_started, <<"00000000-0000-0000-0000-000000000001">>, OsPid} when is_integer(OsPid) ->
            ok
    after 2000 ->
        ?assert(false)
    end,
    receive
        {agent_exit, <<"00000000-0000-0000-0000-000000000001">>, _Reason} ->
            ok
    after 3000 ->
        exit(Pid, kill),
        ?assert(false)
    end.

hot_code_change_keeps_subprocess_alive_test() ->
    {ok, _} = application:ensure_all_started(erlexec),
    Spec = #{
        agent_id => <<"00000000-0000-0000-0000-000000000002">>,
        argv => [<<"/bin/sh">>, <<"-lc">>, <<"sleep 5">>],
        cwd => <<"/tmp">>,
        env => #{},
        cols => 80,
        rows => 24,
        notify => self()
    },
    {ok, Pid} = spawnd_agent:start_link(Spec),
    receive
        {agent_started, <<"00000000-0000-0000-0000-000000000002">>, _OsPid} -> ok
    after 2000 ->
        exit(Pid, kill),
        ?assert(false)
    end,
    #{<<"pid">> := Before} = spawnd_agent:status(Pid),
    ok = sys:suspend(Pid),
    ok = sys:change_code(Pid, spawnd_agent, <<"0.1.0">>, []),
    ok = sys:resume(Pid),
    #{<<"pid">> := After} = spawnd_agent:status(Pid),
    ?assertEqual(Before, After),
    spawnd_agent:stop_agent(Pid),
    receive
        {agent_exit, <<"00000000-0000-0000-0000-000000000002">>, _Reason} -> ok
    after 4500 ->
        exit(Pid, kill),
        ?assert(false)
    end.

stop_agent_waits_for_subprocess_exit_test() ->
    {ok, _} = application:ensure_all_started(erlexec),
    AgentId = <<"00000000-0000-0000-0000-000000000003">>,
    Spec = #{
        agent_id => AgentId,
        argv => [<<"/bin/sh">>, <<"-lc">>, <<"while :; do sleep 1; done">>],
        cwd => <<"/tmp">>,
        env => #{},
        cols => 80,
        rows => 24,
        notify => self(),
        report => false
    },
    {ok, Pid} = spawnd_agent:start_link(Spec),
    receive
        {agent_started, AgentId, _OsPid} -> ok
    after 2000 ->
        exit(Pid, kill),
        ?assert(false)
    end,
    spawnd_agent:stop_agent(Pid),
    receive
        {agent_exit, AgentId, _Reason} -> ok
    after 4500 ->
        exit(Pid, kill),
        ?assert(false)
    end.

relative_executable_uses_agent_path_env_test() ->
    {ok, _} = application:ensure_all_started(erlexec),
    AgentId = <<"00000000-0000-0000-0000-000000000004">>,
    Base = filename:join(
        os:getenv("TMPDIR", "/tmp"),
        "spawnd-agent-path-" ++ integer_to_list(erlang:unique_integer([positive]))
    ),
    ok = filelib:ensure_dir(filename:join(Base, "x")),
    Command = "spawnd-agent-path-command",
    Script = filename:join(Base, Command),
    ok = file:write_file(Script, <<"#!/bin/sh\nsleep 1\n">>),
    ok = file:change_mode(Script, 8#755),
    OldPath = os:getenv("PATH"),
    Spec = #{
        agent_id => AgentId,
        argv => [list_to_binary(Command)],
        cwd => <<"/tmp">>,
        env => #{
            <<"PATH">> => list_to_binary(Base ++ ":" ++ path_or_empty(OldPath))
        },
        cols => 80,
        rows => 24,
        notify => self(),
        report => false
    },
    try
        {ok, Pid} = spawnd_agent:start_link(Spec),
        receive
            {agent_started, AgentId, _OsPid} -> ok
        after 2000 ->
            exit(Pid, kill),
            ?assert(false)
        end,
        receive
            {agent_exit, AgentId, _Reason} -> ok
        after 3000 ->
            exit(Pid, kill),
            ?assert(false)
        end
    after
        _ = file:del_dir_r(Base)
    end.

path_or_empty(false) ->
    "";
path_or_empty(Path) ->
    Path.
-endif.
