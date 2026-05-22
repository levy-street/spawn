-module(spawnd_control).
-behaviour(gen_server).

-export([start_link/0, request/1, request_remote/1]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, code_change/3]).

start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

request(Request) ->
    gen_server:call(?MODULE, {request, Request}, 5000).

init([]) ->
    case gen_tcp:listen(port(), [binary, {packet, line}, {active, false}, {reuseaddr, true}, {ip, {127,0,0,1}}]) of
        {ok, Listen} ->
            self() ! accept,
            {ok, #{listen => Listen}};
        {error, Reason} ->
            io:format(standard_error, "spawn: control socket disabled: ~p~n", [Reason]),
            {ok, #{}}
    end.

handle_call({request, <<"status">>}, _From, State) ->
    {reply, spawnd_registry:status(), State};
handle_call({request, <<"agents">>}, _From, State) ->
    {reply, spawnd_registry:status(), State};
handle_call({request, {kill, AgentId}}, _From, State) ->
    Reply =
        case spawnd_registry:lookup(AgentId) of
            {ok, Pid} ->
                spawnd_agent:stop_agent(Pid),
                #{<<"ok">> => true};
            not_found ->
                #{<<"ok">> => false, <<"error">> => <<"agent not found">>}
        end,
    {reply, Reply, State};
handle_call({request, <<"update-check">>}, _From, State) ->
    {reply, spawnd_update:check(), State};
handle_call({request, <<"self-test">>}, _From, State) ->
    {reply, run_self_check(), State};
handle_call({request, _}, _From, State) ->
    {reply, #{<<"ok">> => false, <<"error">> => <<"unknown command">>}, State}.

handle_cast(_Msg, State) ->
    {noreply, State}.

handle_info(accept, State = #{listen := Listen}) ->
    case gen_tcp:accept(Listen, 0) of
        {ok, Socket} ->
            spawn(fun() -> serve(Socket) end),
            self() ! accept,
            {noreply, State};
        {error, timeout} ->
            erlang:send_after(100, self(), accept),
            {noreply, State};
        {error, _} ->
            {noreply, State}
    end;
handle_info(_Msg, State) ->
    {noreply, State}.

code_change(_OldVsn, State, _Extra) ->
    {ok, State}.

request_remote(Request) ->
    case gen_tcp:connect({127,0,0,1}, port(), [binary, {packet, line}, {active, false}], 2000) of
        {ok, Socket} ->
            ok = gen_tcp:send(Socket, [spawnd_json:encode(Request), <<"\n">>]),
            Reply =
                case gen_tcp:recv(Socket, 0, 5000) of
                    {ok, Bin} -> spawnd_json:decode(Bin);
                    Error -> Error
                end,
            gen_tcp:close(Socket),
            Reply;
        Error ->
            Error
    end.

serve(Socket) ->
    Reply =
        case gen_tcp:recv(Socket, 0, 5000) of
            {ok, Bin} ->
                case spawnd_json:decode(Bin) of
                    {ok, #{<<"command">> := <<"agents">>}} ->
                        spawnd_registry:status();
                    {ok, #{<<"command">> := <<"status">>}} ->
                        spawnd_registry:status();
                    {ok, #{<<"command">> := <<"kill">>, <<"agent_id">> := AgentId}} ->
                        request({kill, AgentId});
                    {ok, #{<<"command">> := <<"update-check">>}} ->
                        spawnd_update:check();
                    {ok, #{<<"command">> := <<"self-test">>}} ->
                        run_self_check();
                    _ ->
                        #{<<"ok">> => false, <<"error">> => <<"bad request">>}
                end;
            Error ->
                #{<<"ok">> => false, <<"error">> => list_to_binary(io_lib:format("~p", [Error]))}
        end,
    _ = gen_tcp:send(Socket, [spawnd_json:encode(Reply), <<"\n">>]),
    gen_tcp:close(Socket).

port() ->
    case os:getenv("SPAWND_CONTROL_PORT") of
        false -> 8346;
        Value -> list_to_integer(Value)
    end.

run_self_check() ->
    AgentId = <<"00000000-0000-0000-0000-00000000ffff">>,
    Spec = #{
        agent_id => AgentId,
        argv => [<<"/bin/sh">>, <<"-lc">>, <<"printf ok">>],
        cwd => <<"/tmp">>,
        env => #{},
        cols => 80,
        rows => 24,
        notify => self(),
        report => false
    },
    case spawnd_agent_sup:start_agent(Spec) of
        {ok, Pid} ->
            receive
                {agent_started, AgentId, OsPid} when is_integer(OsPid) ->
                    wait_self_test_exit(AgentId, Pid)
            after 2000 ->
                exit(Pid, kill),
                #{<<"ok">> => false, <<"error">> => <<"timeout waiting for start">>}
            end;
        Error ->
            #{<<"ok">> => false, <<"error">> => list_to_binary(io_lib:format("~p", [Error]))}
    end.

wait_self_test_exit(AgentId, Pid) ->
    receive
        {agent_exit, AgentId, _Reason} ->
            #{<<"ok">> => true}
    after 3000 ->
        exit(Pid, kill),
        #{<<"ok">> => false, <<"error">> => <<"timeout waiting for exit">>}
    end.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

bad_remote_when_daemon_not_running_test() ->
    Port = integer_to_list(30000 + rand:uniform(10000)),
    os:putenv("SPAWND_CONTROL_PORT", Port),
    ?assertMatch({error, _}, request_remote(#{<<"command">> => <<"agents">>})),
    os:unsetenv("SPAWND_CONTROL_PORT").
-endif.
