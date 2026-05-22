-module(spawnd_agent).
-behaviour(gen_server).

-export([start_link/1, stdin/2, resize/3, snapshot/2, redraw/1, stop_agent/1, status/1]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2, code_change/3]).

-define(MAX_BUFFER, 2097152).

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
    notify = undefined
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
    case Argv of
        [] ->
            {stop, empty_argv};
        [Exe0 | Args] ->
            Exe = resolve_executable(Exe0),
            Cmd = [Exe | [binary_or_list(A) || A <- Args]],
            Opts = [
                stdin,
                stdout,
                {stderr, stdout},
                pty,
                monitor,
                kill_group,
                {kill_timeout, 5},
                {winsz, {Rows, Cols}},
                {cd, binary_or_list(Cwd)},
                {env, normalize_env(Env)}
            ],
            case exec:run_link(Cmd, Opts) of
                {ok, ProcPid, OsPid} ->
                    spawnd_ws:send_json(#{
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
                        notify = Notify
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
    _ = exec:stop(OsPid),
    {noreply, State}.

handle_info({stdout, _OsPid, Data}, State) ->
    output(Data, State);
handle_info({stderr, _OsPid, Data}, State) ->
    output(Data, State);
handle_info({'DOWN', _OsPid, process, _Pid, Reason}, State = #state{agent_id = AgentId}) ->
    {ExitCode, Signal} = decode_exit(Reason),
    spawnd_ws:send_json(#{
        <<"type">> => <<"agent.exit">>,
        <<"agent_id">> => AgentId,
        <<"exit_code">> => ExitCode,
        <<"signal">> => Signal
    }),
    maybe_notify(State#state.notify, {agent_exit, AgentId, Reason}),
    spawnd_registry:unregister(AgentId),
    {stop, normal, State};
handle_info({'EXIT', _Pid, Reason}, State = #state{agent_id = AgentId}) ->
    maybe_notify(State#state.notify, {agent_exit, AgentId, Reason}),
    spawnd_registry:unregister(AgentId),
    {stop, normal, State};
handle_info(_Msg, State) ->
    {noreply, State}.

terminate(_Reason, #state{os_pid = undefined}) ->
    ok;
terminate(_Reason, #state{os_pid = OsPid}) ->
    _ = catch exec:stop(OsPid),
    ok.

code_change(_OldVsn, State, _Extra) ->
    {ok, State}.

output(Data0, State = #state{agent_id = AgentId, buffer = Buffer}) ->
    Data = iolist_to_binary(Data0),
    spawnd_ws:send_binary(spawnd_frames:encode_output(AgentId, Data)),
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

resolve_executable(Exe0) ->
    Exe = binary_or_list(Exe0),
    case filename:pathtype(Exe) of
        absolute -> Exe;
        _ ->
            case os:find_executable(Exe) of
                false -> Exe;
                Path -> Path
            end
    end.

maybe_notify(undefined, _Msg) ->
    ok;
maybe_notify(Pid, Msg) when is_pid(Pid) ->
    Pid ! Msg,
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
    after 3000 ->
        exit(Pid, kill),
        ?assert(false)
    end.
-endif.
