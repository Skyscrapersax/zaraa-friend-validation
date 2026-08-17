import { PluginManifest, AbletonPluginConfig } from '@zaraa/shared';

type OscValue = string | number | boolean | null;
/**
 * A well-formed OSC address path — must start with `/`.
 *
 * Template-literal type provides a compile-time check for statically-known
 * addresses; use {@link validateOscAddress} to enforce the same contract on
 * dynamically-constructed paths at runtime.
 */
type OscAddress = `/${string}`;
/** Typed argument list for an outgoing or incoming OSC message. */
type OscArgs = OscValue[];
interface OscReply {
    address: OscAddress;
    args: OscArgs;
}
interface AbletonOscTransport {
    send(address: OscAddress, args?: OscArgs): Promise<void>;
    request(address: OscAddress, args?: OscArgs, timeoutMs?: number): Promise<OscReply>;
    close?(): Promise<void> | void;
}
interface AbletonOscUdpTransportOptions {
    host?: string;
    sendPort?: number;
    receivePort?: number;
    timeoutMs?: number;
}
declare class AbletonOscUdpTransport implements AbletonOscTransport {
    private readonly host;
    private readonly sendPort;
    private readonly receivePort;
    private readonly timeoutMs;
    private port;
    private openPromise;
    private pending;
    constructor(options?: AbletonOscUdpTransportOptions);
    send(address: string, args?: OscValue[]): Promise<void>;
    request(address: string, args?: OscValue[], timeoutMs?: number): Promise<OscReply>;
    close(): Promise<void>;
    private open;
    private handleMessage;
}

interface AbletonHandlerDeps {
    transport?: AbletonOscTransport;
    timeoutMs?: number;
    host?: string;
    sendPort?: number;
    receivePort?: number;
}
interface AbletonToolHandlers {
    ableton_ping(args: unknown): Promise<string>;
    ableton_get_session(args: unknown): Promise<string>;
    ableton_list_tracks(args: unknown): Promise<string>;
    ableton_list_clip_slots(args: unknown): Promise<string>;
    ableton_list_scenes(args: unknown): Promise<string>;
    ableton_get_clip_notes(args: unknown): Promise<string>;
    ableton_get_selection(args: unknown): Promise<string>;
    ableton_list_devices(args: unknown): Promise<string>;
    ableton_get_device_parameters(args: unknown): Promise<string>;
    ableton_set_tempo(args: unknown): Promise<string>;
    ableton_create_midi_track(args: unknown): Promise<string>;
    ableton_create_midi_clip(args: unknown): Promise<string>;
    ableton_add_notes(args: unknown): Promise<string>;
    ableton_fire_clip(args: unknown): Promise<string>;
    ableton_play_stop(args: unknown): Promise<string>;
    ableton_set_track_pan(args: unknown): Promise<string>;
    ableton_set_track_volume(args: unknown): Promise<string>;
    ableton_set_track_mute(args: unknown): Promise<string>;
    ableton_set_track_solo(args: unknown): Promise<string>;
    ableton_fire_scene(args: unknown): Promise<string>;
    ableton_set_device_parameter(args: unknown): Promise<string>;
    ableton_get_track_mixer(args: unknown): Promise<string>;
    [tool: string]: (args: unknown) => Promise<string>;
}
declare function createAbletonHandlers(deps?: AbletonHandlerDeps): AbletonToolHandlers;

declare const manifest: PluginManifest;

type AbletonPluginInstance = {
    manifest: typeof manifest;
    handlers: ReturnType<typeof createAbletonHandlers>;
};
declare function createAbletonPlugin(config: AbletonPluginConfig | undefined, deps?: AbletonHandlerDeps): AbletonPluginInstance | null;

export { type AbletonHandlerDeps, type AbletonOscTransport, AbletonOscUdpTransport, type AbletonOscUdpTransportOptions, type AbletonPluginInstance, type AbletonToolHandlers, type OscReply, type OscValue, createAbletonHandlers, createAbletonPlugin, manifest };
